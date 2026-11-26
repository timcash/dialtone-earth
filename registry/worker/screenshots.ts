import type { KvNamespaceBinding } from "./auth.ts";
import type { R2BucketBinding } from "./registry.ts";

export interface ScreenshotsEnv {
  DIALTONE_AUTH_TOKENS?: KvNamespaceBinding;
  DIALTONE_REGISTRY?: R2BucketBinding;
}

export interface PublishedScreenshotFile {
  filename: string;
  content_type: string;
  bytes: number;
  sha256: string;
  r2_key?: string;
}

export interface PublishedScreenshotManifest {
  loop_id: string;
  generated_at: string;
  committed_at: string;
  files: PublishedScreenshotFile[];
  manifest?: Record<string, unknown>;
}

const LATEST_MANIFEST_KV_KEY = "registry:screenshots:latest";
const R2_PREFIX = "screenshots/latest/";
const SAFE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(png|html|json)$/i;

const SCREENSHOTS_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

function isSafeFilename(name: string): boolean {
  return SAFE_FILE_RE.test(name) && !name.includes("..");
}

function contentTypeFor(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".html")) return "text/html; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function responseHeaders(
  securityHeaders: Record<string, string>,
  contentType: string,
): Headers {
  const headers = new Headers(securityHeaders);
  headers.set("Content-Security-Policy", SCREENSHOTS_CSP);
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return headers;
}

function jsonResp(
  payload: unknown,
  status: number,
  securityHeaders: Record<string, string>,
): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: responseHeaders(securityHeaders, "application/json; charset=utf-8"),
  });
}

async function readStoredManifest(
  kv: KvNamespaceBinding | undefined,
): Promise<PublishedScreenshotManifest | null> {
  if (!kv) return null;
  const raw = await kv.get(LATEST_MANIFEST_KV_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PublishedScreenshotManifest;
  } catch {
    return null;
  }
}

/**
 * Handles owner-authenticated stable-link screenshot endpoints on test.dialtone.earth:
 *   GET  /screenshots                         -> 302 /screenshots/
 *   GET  /screenshots/                        -> latest index.html from R2 (or null to fall back to local staging origin)
 *   GET  /screenshots/<file>                  -> latest PNG / HTML / JSON from R2
 *   GET  /api/screenshots/latest              -> latest committed manifest JSON from KV
 *   PUT  /api/screenshots/latest/files/<file> -> upload one screenshot asset into R2
 *   POST /api/screenshots/latest/commit       -> atomically commit latest manifest in KV and delete stale R2 files
 */
export async function handleScreenshotsRoute(
  request: Request,
  env: ScreenshotsEnv,
  securityHeaders: Record<string, string>,
  nowSec: number,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const kv = env.DIALTONE_AUTH_TOKENS;
  const r2 = env.DIALTONE_REGISTRY;

  if (path === "/screenshots" && (request.method === "GET" || request.method === "HEAD")) {
    const headers = responseHeaders(securityHeaders, "text/plain; charset=utf-8");
    headers.set("Location", "/screenshots/");
    return new Response(null, { status: 302, headers });
  }

  if (path.startsWith("/screenshots/") && (request.method === "GET" || request.method === "HEAD")) {
    const relName = path.slice("/screenshots/".length) || "index.html";
    if (!isSafeFilename(relName)) {
      return jsonResp({ error: "Invalid screenshot filename" }, 400, securityHeaders);
    }
    if (!r2) {
      return null;
    }
    const obj = await r2.get(R2_PREFIX + relName);
    if (!obj) {
      // Return null so test.dialtone.earth can fall back to local Vite /__staging/screenshots/ if not yet published to R2.
      return null;
    }
    const ct = obj.httpMetadata?.contentType || contentTypeFor(relName);
    const headers = responseHeaders(securityHeaders, ct);
    if (typeof obj.size === "number") {
      headers.set("Content-Length", String(obj.size));
    }
    if (obj.customMetadata?.sha256) {
      headers.set("X-Dialtone-Sha256", obj.customMetadata.sha256);
    }
    return new Response(request.method === "HEAD" ? null : (obj.body as BodyInit), {
      status: 200,
      headers,
    });
  }

  if (path === "/api/screenshots/latest" && request.method === "GET") {
    const stored = await readStoredManifest(kv);
    if (!stored) {
      return jsonResp(
        { error: "No screenshot loop published yet" },
        404,
        securityHeaders,
      );
    }
    return jsonResp(stored, 200, securityHeaders);
  }

  const uploadPrefix = "/api/screenshots/latest/files/";
  if (path.startsWith(uploadPrefix) && request.method === "PUT") {
    if (!r2) {
      return jsonResp(
        { error: "DIALTONE_REGISTRY R2 binding is not configured" },
        503,
        securityHeaders,
      );
    }
    const rawName = decodeURIComponent(path.slice(uploadPrefix.length));
    if (!isSafeFilename(rawName)) {
      return jsonResp({ error: "Invalid screenshot filename" }, 400, securityHeaders);
    }
    const buf = await request.arrayBuffer();
    if (buf.byteLength === 0) {
      return jsonResp({ error: "Empty screenshot payload" }, 400, securityHeaders);
    }
    const ct = request.headers.get("Content-Type") || contentTypeFor(rawName);
    const sha256 = (request.headers.get("X-Dialtone-Sha256") || "").trim();
    const loopId = (request.headers.get("X-Dialtone-Loop-Id") || "").trim();
    const key = R2_PREFIX + rawName;
    await r2.put(key, buf, {
      httpMetadata: {
        contentType: ct,
        cacheControl: "private, no-store",
      },
      customMetadata: {
        ...(sha256 ? { sha256 } : {}),
        ...(loopId ? { loop_id: loopId } : {}),
      },
    });
    return jsonResp(
      { ok: true, filename: rawName, key, bytes: buf.byteLength },
      200,
      securityHeaders,
    );
  }

  if (path === "/api/screenshots/latest/commit" && request.method === "POST") {
    if (!kv || !r2) {
      return jsonResp(
        { error: "DIALTONE_AUTH_TOKENS KV and DIALTONE_REGISTRY R2 bindings are required" },
        503,
        securityHeaders,
      );
    }
    let body: {
      loop_id?: string;
      generated_at?: string;
      files?: PublishedScreenshotFile[];
      manifest?: Record<string, unknown>;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return jsonResp({ error: "Invalid JSON commit payload" }, 400, securityHeaders);
    }
    const loopId = String(body.loop_id || "").trim();
    const files = Array.isArray(body.files) ? body.files : [];
    if (!loopId || files.length === 0) {
      return jsonResp(
        { error: "loop_id and non-empty files list are required" },
        400,
        securityHeaders,
      );
    }

    const keepNames = new Set<string>();
    const sanitizedFiles: PublishedScreenshotFile[] = [];
    for (const f of files) {
      if (!f || typeof f.filename !== "string" || !isSafeFilename(f.filename)) {
        return jsonResp(
          { error: `Invalid filename in commit manifest: ${String(f?.filename ?? "")}` },
          400,
          securityHeaders,
        );
      }
      keepNames.add(f.filename);
      sanitizedFiles.push({
        filename: f.filename,
        content_type: f.content_type || contentTypeFor(f.filename),
        bytes: Number(f.bytes) || 0,
        sha256: String(f.sha256 || ""),
        r2_key: R2_PREFIX + f.filename,
      });
    }

    const previous = await readStoredManifest(kv);
    const deleted: string[] = [];
    if (previous && Array.isArray(previous.files) && typeof r2.delete === "function") {
      for (const oldFile of previous.files) {
        if (oldFile && typeof oldFile.filename === "string" && !keepNames.has(oldFile.filename) && isSafeFilename(oldFile.filename)) {
          await r2.delete(R2_PREFIX + oldFile.filename);
          deleted.push(oldFile.filename);
        }
      }
    }

    const record: PublishedScreenshotManifest = {
      loop_id: loopId,
      generated_at: String(body.generated_at || new Date(nowSec * 1000).toISOString()),
      committed_at: new Date(nowSec * 1000).toISOString(),
      files: sanitizedFiles,
      manifest: body.manifest,
    };
    await kv.put(LATEST_MANIFEST_KV_KEY, JSON.stringify(record));

    return jsonResp(
      {
        ok: true,
        loop_id: loopId,
        stable_url: `${url.origin}/screenshots/`,
        file_count: sanitizedFiles.length,
        pruned_stale_files: deleted,
      },
      200,
      securityHeaders,
    );
  }

  return null;
}
