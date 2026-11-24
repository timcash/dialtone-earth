import type { KvNamespaceBinding } from "./auth.ts";
import { isPublicLiveHost } from "./live.ts";

export interface R2ObjectBodyLike {
  body: ReadableStream | Uint8Array | ArrayBuffer | string;
  size?: number;
  etag?: string;
  httpMetadata?: {
    contentType?: string;
    cacheControl?: string;
  };
  customMetadata?: Record<string, string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2BucketBinding {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream | string | null,
    options?: {
      httpMetadata?: { contentType?: string; cacheControl?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  delete?(key: string): Promise<void>;
}

export interface RegistryEnv {
  DIALTONE_AUTH_TOKENS?: KvNamespaceBinding;
  DIALTONE_REGISTRY?: R2BucketBinding;
  LIVE_CONTROL_TOKEN?: string;
}

export interface RepoCommitSummary {
  sha: string;
  branch: string;
  subject: string;
  author: string;
  pushed_at: string;
  bundle_key: string;
  bundle_sha256: string;
  bundle_bytes: number;
}

export interface RepoArchiveEntry {
  filename: string;
  key: string;
  sha256: string;
  bytes: number;
  updated_at: string;
}

export interface StoredRepoRecord {
  name: string;
  default_branch: string;
  head_sha: string;
  head_subject: string;
  updated_at: string;
  branches: Record<string, RepoCommitSummary>;
  archives: Record<string, RepoArchiveEntry>;
  tags: string[];
  history: RepoCommitSummary[];
}

export interface ReleaseAssetRecord {
  name: string;
  key: string;
  sha256: string;
  bytes: number;
  content_type: string;
  updated_at: string;
}

export interface StoredReleaseRecord {
  repo: string;
  tag: string;
  sha: string;
  notes: string;
  published_by: string;
  created_at: string;
  updated_at: string;
  assets: Record<string, ReleaseAssetRecord>;
}

export interface PublicPluginRecord {
  name: string;
  version: string;
  description: string;
  kind: string;
  protocols: string[];
  repo: string;
  iroh_ticket: string;
  blake3_hash: string;
  blob_digest: string;
  bytes: number;
  updated_at: string;
  assets: Record<string, ReleaseAssetRecord>;
}

const REPO_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const TAG_RE = /^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9][A-Za-z0-9.-]*)?$/;
const ASSET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA_RE = /^[0-9a-f]{7,64}$/i;
const PLUGIN_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const CODE_INDEX_KEY = "registry:code:index";
const PLUGINS_INDEX_KEY = "registry:plugins:index";
const codeRepoKey = (repo: string) => `registry:code:repo:${repo}`;
const releasesIndexKey = (repo: string) => `registry:releases:index:${repo}`;
const releaseRecordKey = (repo: string, tag: string) =>
  `registry:releases:item:${repo}:${tag}`;
const pluginRecordKey = (name: string) => `registry:plugins:item:${name}`;

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const maxLen = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < maxLen; i += 1) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

function isAuthorizedControl(request: Request, env: RegistryEnv): boolean {
  const expected = (env.LIVE_CONTROL_TOKEN ?? "").trim();
  if (!expected) return false;
  const header = (request.headers.get("Authorization") ?? "").trim();
  if (!header.toLowerCase().startsWith("bearer ")) return false;
  const provided = header.slice(7).trim();
  if (!provided) return false;
  return constantTimeEqual(provided, expected);
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function jsonResp(
  payload: unknown,
  status: number,
  securityHeaders: Record<string, string>,
): Response {
  const headers = new Headers(securityHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(payload, null, 2), { status, headers });
}

function textResp(
  body: string,
  status: number,
  securityHeaders: Record<string, string>,
): Response {
  const headers = new Headers(securityHeaders);
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(body, { status, headers });
}

function cleanText(value: unknown, maxLen: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function isValidBranch(branch: string): boolean {
  return BRANCH_RE.test(branch) && !branch.includes("..");
}

async function readJsonKv<T>(
  kv: KvNamespaceBinding,
  key: string,
): Promise<T | null> {
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function addToIndex(
  kv: KvNamespaceBinding,
  indexKey: string,
  item: string,
): Promise<string[]> {
  const current = (await readJsonKv<string[]>(kv, indexKey)) ?? [];
  const next = Array.from(new Set([...current, item])).sort();
  await kv.put(indexKey, JSON.stringify(next));
  return next;
}

function binaryResp(
  obj: R2ObjectBodyLike,
  contentType: string,
  filename: string,
  sha256: string,
  securityHeaders: Record<string, string>,
): Response {
  const headers = new Headers(securityHeaders);
  headers.set("Content-Type", contentType || "application/octet-stream");
  headers.set("Content-Disposition", `attachment; filename="${filename}"`);
  headers.set("Cache-Control", "no-store");
  if (sha256) headers.set("X-Dialtone-Sha256", sha256);
  if (typeof obj.size === "number") headers.set("Content-Length", String(obj.size));
  return new Response(obj.body as BodyInit, { status: 200, headers });
}

export async function handleRegistryRoute(
  request: Request,
  env: RegistryEnv,
  securityHeaders: Record<string, string>,
  nowSec: number,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const isCode = path === "/api/code" || path.startsWith("/api/code/");
  const isApiReleases =
    path === "/api/releases" || path.startsWith("/api/releases/");
  const isPublicReleases = path.startsWith("/releases/");
  const isPublicPlugins =
    path === "/api/plugins" || path.startsWith("/api/plugins/");

  if (!isCode && !isApiReleases && !isPublicReleases && !isPublicPlugins) {
    return null;
  }

  if (!isPublicLiveHost(url.hostname)) {
    return jsonResp(
      { error: "Dialtone registry is served from dialtone.earth" },
      404,
      securityHeaders,
    );
  }

  const kv = env.DIALTONE_AUTH_TOKENS;
  const r2 = env.DIALTONE_REGISTRY;
  const nowIso = new Date(nowSec * 1000).toISOString();

  const requireWriteAuth = (): Response | null => {
    if (!isAuthorizedControl(request, env)) {
      return jsonResp(
        { error: "Bearer LIVE_CONTROL_TOKEN required" },
        401,
        securityHeaders,
      );
    }
    if (!kv) {
      return jsonResp(
        { error: "DIALTONE_AUTH_TOKENS KV binding is not configured" },
        503,
        securityHeaders,
      );
    }
    return null;
  };

  // ===========================================================================
  // 1. CODE STORAGE (/api/code)
  // ===========================================================================
  if (path === "/api/code" && request.method === "GET") {
    if (!kv) return jsonResp({ repos: [] }, 200, securityHeaders);
    const names = (await readJsonKv<string[]>(kv, CODE_INDEX_KEY)) ?? [];
    const records = await Promise.all(
      names.map((name) => readJsonKv<StoredRepoRecord>(kv, codeRepoKey(name))),
    );
    const repos = records
      .filter((r): r is StoredRepoRecord => Boolean(r))
      .map((r) => ({
        name: r.name,
        default_branch: r.default_branch,
        head_sha: r.head_sha,
        head_subject: r.head_subject,
        updated_at: r.updated_at,
        tags: r.tags,
        bundle_url: `${url.origin}/api/code/${r.name}/bundle`,
      }));
    return jsonResp({ repos }, 200, securityHeaders);
  }

  // GET /api/code/<repo>
  const codeRepoMatch = /^\/api\/code\/([^/]+)$/.exec(path);
  if (codeRepoMatch && request.method === "GET") {
    const repo = codeRepoMatch[1];
    if (!REPO_RE.test(repo)) {
      return jsonResp({ error: "Invalid repo name" }, 400, securityHeaders);
    }
    if (!kv) return jsonResp({ error: "Repo not found" }, 404, securityHeaders);
    const rec = await readJsonKv<StoredRepoRecord>(kv, codeRepoKey(repo));
    if (!rec) return jsonResp({ error: "Repo not found" }, 404, securityHeaders);
    return jsonResp(
      {
        ...rec,
        bundle_url: `${url.origin}/api/code/${repo}/bundle`,
      },
      200,
      securityHeaders,
    );
  }

  // PUT /api/code/<repo>/push
  const codePushMatch = /^\/api\/code\/([^/]+)\/push$/.exec(path);
  if (codePushMatch && request.method === "PUT") {
    const denied = requireWriteAuth();
    if (denied) return denied;
    if (!r2) {
      return jsonResp(
        { error: "DIALTONE_REGISTRY R2 binding is not configured" },
        503,
        securityHeaders,
      );
    }
    const repo = codePushMatch[1];
    if (!REPO_RE.test(repo)) {
      return jsonResp({ error: "Invalid repo name" }, 400, securityHeaders);
    }
    const branch = cleanText(
      request.headers.get("X-Dialtone-Branch") || "main",
      64,
    );
    if (!isValidBranch(branch)) {
      return jsonResp({ error: "Invalid branch name" }, 400, securityHeaders);
    }
    const sha = cleanText(request.headers.get("X-Dialtone-Sha") || "", 64).toLowerCase();
    if (!SHA_RE.test(sha)) {
      return jsonResp(
        { error: "X-Dialtone-Sha header with git commit SHA is required" },
        400,
        securityHeaders,
      );
    }
    const subject = cleanText(
      request.headers.get("X-Dialtone-Subject") || "(no subject)",
      200,
    );
    const author = cleanText(
      request.headers.get("X-Dialtone-Author") || "dialtone-cli",
      80,
    );
    const tag = cleanText(request.headers.get("X-Dialtone-Tag") || "", 64);
    if (tag && !TAG_RE.test(tag)) {
      return jsonResp({ error: "Invalid tag format (expected vX.Y.Z)" }, 400, securityHeaders);
    }

    const buf = await request.arrayBuffer();
    if (buf.byteLength === 0) {
      return jsonResp({ error: "Empty git bundle payload" }, 400, securityHeaders);
    }
    const bundleSha256 = await sha256Hex(buf);
    const bundleKey = `code/${repo}/bundles/${sha}.bundle`;
    await r2.put(bundleKey, buf, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { repo, branch, sha, sha256: bundleSha256 },
    });

    const existing = (await readJsonKv<StoredRepoRecord>(kv!, codeRepoKey(repo))) ?? {
      name: repo,
      default_branch: branch,
      head_sha: sha,
      head_subject: subject,
      updated_at: nowIso,
      branches: {},
      archives: {},
      tags: [],
      history: [],
    };
    const commit: RepoCommitSummary = {
      sha,
      branch,
      subject,
      author,
      pushed_at: nowIso,
      bundle_key: bundleKey,
      bundle_sha256: bundleSha256,
      bundle_bytes: buf.byteLength,
    };
    existing.branches[branch] = commit;
    if (branch === existing.default_branch || branch === "main") {
      existing.default_branch = branch;
      existing.head_sha = sha;
      existing.head_subject = subject;
    }
    existing.updated_at = nowIso;
    if (tag && !existing.tags.includes(tag)) {
      existing.tags = [...existing.tags, tag];
    }
    existing.history = [
      commit,
      ...existing.history.filter((c) => c.sha !== sha || c.branch !== branch),
    ].slice(0, 30);

    await kv!.put(codeRepoKey(repo), JSON.stringify(existing));
    await addToIndex(kv!, CODE_INDEX_KEY, repo);

    return jsonResp(
      {
        ok: true,
        repo,
        branch,
        sha,
        bundle_bytes: buf.byteLength,
        bundle_sha256: bundleSha256,
        bundle_url: `${url.origin}/api/code/${repo}/bundle?branch=${encodeURIComponent(branch)}`,
      },
      200,
      securityHeaders,
    );
  }

  // GET /api/code/<repo>/bundle
  const codeBundleMatch = /^\/api\/code\/([^/]+)\/bundle$/.exec(path);
  if (codeBundleMatch && request.method === "GET") {
    const repo = codeBundleMatch[1];
    if (!REPO_RE.test(repo)) {
      return jsonResp({ error: "Invalid repo name" }, 400, securityHeaders);
    }
    if (!kv || !r2) {
      return jsonResp({ error: "Registry storage unavailable" }, 503, securityHeaders);
    }
    const rec = await readJsonKv<StoredRepoRecord>(kv, codeRepoKey(repo));
    if (!rec) return jsonResp({ error: "Repo not found" }, 404, securityHeaders);
    const reqSha = (url.searchParams.get("sha") || "").trim().toLowerCase();
    const reqBranch = (url.searchParams.get("branch") || rec.default_branch || "main").trim();
    let targetKey = "";
    let targetSha256 = "";
    if (reqSha && SHA_RE.test(reqSha)) {
      targetKey = `code/${repo}/bundles/${reqSha}.bundle`;
      const hist = rec.history.find((h) => h.sha === reqSha);
      targetSha256 = hist?.bundle_sha256 || "";
    } else {
      const refCommit = rec.branches[reqBranch] ?? rec.branches[rec.default_branch];
      if (!refCommit) {
        return jsonResp({ error: "Branch not found" }, 404, securityHeaders);
      }
      targetKey = refCommit.bundle_key;
      targetSha256 = refCommit.bundle_sha256;
    }
    const obj = await r2.get(targetKey);
    if (!obj) return jsonResp({ error: "Bundle object not found" }, 404, securityHeaders);
    return binaryResp(
      obj,
      "application/octet-stream",
      `${repo}.bundle`,
      targetSha256,
      securityHeaders,
    );
  }

  // PUT / GET /api/code/<repo>/archive/<filename>
  const codeArchiveMatch = /^\/api\/code\/([^/]+)\/archive\/([^/]+)$/.exec(path);
  if (codeArchiveMatch) {
    const repo = codeArchiveMatch[1];
    const filename = codeArchiveMatch[2];
    if (!REPO_RE.test(repo) || !ASSET_RE.test(filename)) {
      return jsonResp({ error: "Invalid repo or archive filename" }, 400, securityHeaders);
    }
    if (request.method === "PUT") {
      const denied = requireWriteAuth();
      if (denied) return denied;
      if (!r2) {
        return jsonResp({ error: "R2 binding not configured" }, 503, securityHeaders);
      }
      const buf = await request.arrayBuffer();
      if (buf.byteLength === 0) {
        return jsonResp({ error: "Empty archive payload" }, 400, securityHeaders);
      }
      const digest = await sha256Hex(buf);
      const key = `code/${repo}/archives/${filename}`;
      const contentType = filename.endsWith(".zip")
        ? "application/zip"
        : "application/gzip";
      await r2.put(key, buf, {
        httpMetadata: { contentType },
        customMetadata: { repo, filename, sha256: digest },
      });
      const rec = (await readJsonKv<StoredRepoRecord>(kv!, codeRepoKey(repo))) ?? {
        name: repo,
        default_branch: "main",
        head_sha: "",
        head_subject: "",
        updated_at: nowIso,
        branches: {},
        archives: {},
        tags: [],
        history: [],
      };
      rec.archives = rec.archives || {};
      rec.archives[filename] = {
        filename,
        key,
        sha256: digest,
        bytes: buf.byteLength,
        updated_at: nowIso,
      };
      rec.updated_at = nowIso;
      await kv!.put(codeRepoKey(repo), JSON.stringify(rec));
      await addToIndex(kv!, CODE_INDEX_KEY, repo);
      return jsonResp(
        {
          ok: true,
          repo,
          filename,
          sha256: digest,
          bytes: buf.byteLength,
          url: `${url.origin}/api/code/${repo}/archive/${filename}`,
        },
        200,
        securityHeaders,
      );
    }
    if (request.method === "GET") {
      if (!r2) return jsonResp({ error: "R2 binding unavailable" }, 503, securityHeaders);
      const key = `code/${repo}/archives/${filename}`;
      const obj = await r2.get(key);
      if (!obj) return jsonResp({ error: "Archive not found" }, 404, securityHeaders);
      const contentType = filename.endsWith(".zip")
        ? "application/zip"
        : "application/gzip";
      return binaryResp(
        obj,
        contentType,
        filename,
        obj.customMetadata?.sha256 || "",
        securityHeaders,
      );
    }
  }

  // ===========================================================================
  // 2. RELEASES & TAGS (/api/releases/<repo>... & /releases/<repo>/download/...)
  // ===========================================================================
  const relListMatch = /^\/api\/releases\/([^/]+)$/.exec(path);
  if (relListMatch && request.method === "GET") {
    const repo = relListMatch[1];
    if (!REPO_RE.test(repo)) {
      return jsonResp({ error: "Invalid repo name" }, 400, securityHeaders);
    }
    if (!kv) return jsonResp({ repo, releases: [] }, 200, securityHeaders);
    const tags = (await readJsonKv<string[]>(kv, releasesIndexKey(repo))) ?? [];
    const recs = await Promise.all(
      tags.map((t) => readJsonKv<StoredReleaseRecord>(kv, releaseRecordKey(repo, t))),
    );
    const releases = recs
      .filter((r): r is StoredReleaseRecord => Boolean(r))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((r) => ({
        ...r,
        download_base: `${url.origin}/releases/${repo}/download/${r.tag}`,
      }));
    return jsonResp({ repo, releases }, 200, securityHeaders);
  }

  const relCreateMatch = /^\/api\/releases\/([^/]+)\/([^/]+)$/.exec(path);
  if (relCreateMatch) {
    const repo = relCreateMatch[1];
    const tag = relCreateMatch[2];
    if (!REPO_RE.test(repo) || !TAG_RE.test(tag)) {
      return jsonResp({ error: "Invalid repo or release tag (expected vX.Y.Z)" }, 400, securityHeaders);
    }
    if (request.method === "GET") {
      if (!kv) return jsonResp({ error: "Release not found" }, 404, securityHeaders);
      const rec = await readJsonKv<StoredReleaseRecord>(kv, releaseRecordKey(repo, tag));
      if (!rec) return jsonResp({ error: "Release not found" }, 404, securityHeaders);
      return jsonResp(
        { ...rec, download_base: `${url.origin}/releases/${repo}/download/${tag}` },
        200,
        securityHeaders,
      );
    }
    if (request.method === "POST" || request.method === "PUT") {
      const denied = requireWriteAuth();
      if (denied) return denied;
      let body: Record<string, unknown> = {};
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        // empty JSON allowed
      }
      const existing = await readJsonKv<StoredReleaseRecord>(
        kv!,
        releaseRecordKey(repo, tag),
      );
      const sha = cleanText(body.sha || existing?.sha || "", 64).toLowerCase();
      const notes = cleanText(body.notes ?? existing?.notes ?? "", 2000);
      const publishedBy = cleanText(body.published_by || "dialtone-cli", 80);
      const record: StoredReleaseRecord = {
        repo,
        tag,
        sha,
        notes,
        published_by: publishedBy,
        created_at: existing?.created_at || nowIso,
        updated_at: nowIso,
        assets: existing?.assets || {},
      };
      await kv!.put(releaseRecordKey(repo, tag), JSON.stringify(record));
      await addToIndex(kv!, releasesIndexKey(repo), tag);
      // Also record tag in repo metadata if repo exists
      const repoRec = await readJsonKv<StoredRepoRecord>(kv!, codeRepoKey(repo));
      if (repoRec && !repoRec.tags.includes(tag)) {
        repoRec.tags = [...repoRec.tags, tag];
        repoRec.updated_at = nowIso;
        await kv!.put(codeRepoKey(repo), JSON.stringify(repoRec));
      }
      return jsonResp(
        {
          ok: true,
          release: record,
          download_base: `${url.origin}/releases/${repo}/download/${tag}`,
        },
        200,
        securityHeaders,
      );
    }
  }

  // PUT /api/releases/<repo>/<tag>/assets/<asset>
  const relAssetUploadMatch =
    /^\/api\/releases\/([^/]+)\/([^/]+)\/assets\/([^/]+)$/.exec(path);
  if (relAssetUploadMatch && request.method === "PUT") {
    const denied = requireWriteAuth();
    if (denied) return denied;
    if (!r2) {
      return jsonResp({ error: "R2 binding not configured" }, 503, securityHeaders);
    }
    const repo = relAssetUploadMatch[1];
    const tag = relAssetUploadMatch[2];
    const asset = relAssetUploadMatch[3];
    if (!REPO_RE.test(repo) || !TAG_RE.test(tag) || !ASSET_RE.test(asset)) {
      return jsonResp({ error: "Invalid repo, tag, or asset name" }, 400, securityHeaders);
    }
    const buf = await request.arrayBuffer();
    if (buf.byteLength === 0) {
      return jsonResp({ error: "Empty asset payload" }, 400, securityHeaders);
    }
    const digest = await sha256Hex(buf);
    const key = `releases/${repo}/${tag}/${asset}`;
    await r2.put(key, buf, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { repo, tag, asset, sha256: digest },
    });

    const existing = (await readJsonKv<StoredReleaseRecord>(
      kv!,
      releaseRecordKey(repo, tag),
    )) ?? {
      repo,
      tag,
      sha: "",
      notes: "",
      published_by: "dialtone-cli",
      created_at: nowIso,
      updated_at: nowIso,
      assets: {},
    };
    existing.assets[asset] = {
      name: asset,
      key,
      sha256: digest,
      bytes: buf.byteLength,
      content_type: "application/octet-stream",
      updated_at: nowIso,
    };
    existing.updated_at = nowIso;
    await kv!.put(releaseRecordKey(repo, tag), JSON.stringify(existing));
    await addToIndex(kv!, releasesIndexKey(repo), tag);

    return jsonResp(
      {
        ok: true,
        repo,
        tag,
        asset,
        sha256: digest,
        bytes: buf.byteLength,
        download_url: `${url.origin}/releases/${repo}/download/${tag}/${asset}`,
        checksum_url: `${url.origin}/releases/${repo}/download/${tag}/${asset}.sha256`,
      },
      200,
      securityHeaders,
    );
  }

  // Public installer-compatible download endpoint:
  // GET /releases/<repo>/download/<tag>/<asset> (and <asset>.sha256)
  const relDownloadMatch =
    /^\/releases\/([^/]+)\/download\/([^/]+)\/([^/]+)$/.exec(path);
  if (relDownloadMatch && request.method === "GET") {
    const repo = relDownloadMatch[1];
    const tag = relDownloadMatch[2];
    const rawAsset = relDownloadMatch[3];
    if (!REPO_RE.test(repo) || !TAG_RE.test(tag)) {
      return jsonResp({ error: "Invalid repo or tag" }, 400, securityHeaders);
    }
    if (rawAsset.endsWith(".sha256")) {
      const asset = rawAsset.slice(0, -".sha256".length);
      if (!ASSET_RE.test(asset) || !kv) {
        return textResp("Not found\n", 404, securityHeaders);
      }
      const rec = await readJsonKv<StoredReleaseRecord>(kv, releaseRecordKey(repo, tag));
      const entry = rec?.assets?.[asset];
      if (!entry?.sha256) {
        return textResp("Not found\n", 404, securityHeaders);
      }
      return textResp(`${entry.sha256}  ${asset}\n`, 200, securityHeaders);
    }
    if (!ASSET_RE.test(rawAsset) || !r2) {
      return jsonResp({ error: "Release asset not found" }, 404, securityHeaders);
    }
    const key = `releases/${repo}/${tag}/${rawAsset}`;
    const obj = await r2.get(key);
    if (!obj) return jsonResp({ error: "Release asset not found" }, 404, securityHeaders);
    return binaryResp(
      obj,
      "application/octet-stream",
      rawAsset,
      obj.customMetadata?.sha256 || "",
      securityHeaders,
    );
  }

  // ===========================================================================
  // 3. PUBLIC DIALTONE PLUGIN REGISTRY (/api/plugins)
  // ===========================================================================
  if (path === "/api/plugins" && request.method === "GET") {
    if (!kv) return jsonResp({ plugins: [] }, 200, securityHeaders);
    const names = (await readJsonKv<string[]>(kv, PLUGINS_INDEX_KEY)) ?? [];
    const recs = await Promise.all(
      names.map((n) => readJsonKv<PublicPluginRecord>(kv, pluginRecordKey(n))),
    );
    const plugins = recs
      .filter((r): r is PublicPluginRecord => Boolean(r))
      .map((p) => ({
        ...p,
        manifest_url: `${url.origin}/api/plugins/${p.name}`,
        download_urls: Object.fromEntries(
          Object.keys(p.assets || {}).map((asset) => [
            asset,
            `${url.origin}/api/plugins/${p.name}/download/${asset}`,
          ]),
        ),
      }));
    return jsonResp({ plugins }, 200, securityHeaders);
  }

  const pluginItemMatch = /^\/api\/plugins\/([^/]+)$/.exec(path);
  if (pluginItemMatch) {
    const name = pluginItemMatch[1].toLowerCase();
    if (!PLUGIN_RE.test(name)) {
      return jsonResp({ error: "Invalid plugin name" }, 400, securityHeaders);
    }
    if (request.method === "GET") {
      if (!kv) return jsonResp({ error: "Plugin not found" }, 404, securityHeaders);
      const rec = await readJsonKv<PublicPluginRecord>(kv, pluginRecordKey(name));
      if (!rec) return jsonResp({ error: "Plugin not found" }, 404, securityHeaders);
      return jsonResp(
        {
          ...rec,
          download_urls: Object.fromEntries(
            Object.keys(rec.assets || {}).map((asset) => [
              asset,
              `${url.origin}/api/plugins/${name}/download/${asset}`,
            ]),
          ),
        },
        200,
        securityHeaders,
      );
    }
    if (request.method === "PUT" || request.method === "POST") {
      const denied = requireWriteAuth();
      if (denied) return denied;
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return jsonResp({ error: "Invalid JSON body" }, 400, securityHeaders);
      }
      const existing = await readJsonKv<PublicPluginRecord>(kv!, pluginRecordKey(name));
      const protocols = Array.isArray(body.protocols)
        ? body.protocols
            .map((p) => cleanText(p, 80))
            .filter((p) => p.length > 0)
            .slice(0, 16)
        : existing?.protocols || [];
      const record: PublicPluginRecord = {
        name,
        version: cleanText(body.version || existing?.version || "0.1.0", 40),
        description: cleanText(body.description ?? existing?.description ?? "", 280),
        kind: cleanText(body.kind || existing?.kind || "blob-binary", 40),
        protocols,
        repo: cleanText(body.repo || existing?.repo || name, 80),
        iroh_ticket: cleanText(body.iroh_ticket ?? existing?.iroh_ticket ?? "", 1024),
        blake3_hash: cleanText(body.blake3_hash ?? existing?.blake3_hash ?? "", 128),
        blob_digest: cleanText(body.blob_digest ?? existing?.blob_digest ?? "", 128),
        bytes:
          typeof body.bytes === "number" && Number.isFinite(body.bytes) && body.bytes >= 0
            ? Math.floor(body.bytes)
            : existing?.bytes || 0,
        updated_at: nowIso,
        assets: existing?.assets || {},
      };
      await kv!.put(pluginRecordKey(name), JSON.stringify(record));
      await addToIndex(kv!, PLUGINS_INDEX_KEY, name);
      return jsonResp(
        {
          ok: true,
          plugin: record,
          manifest_url: `${url.origin}/api/plugins/${name}`,
        },
        200,
        securityHeaders,
      );
    }
  }

  // PUT /api/plugins/<name>/assets/<asset>
  const pluginAssetUploadMatch =
    /^\/api\/plugins\/([^/]+)\/assets\/([^/]+)$/.exec(path);
  if (pluginAssetUploadMatch && request.method === "PUT") {
    const denied = requireWriteAuth();
    if (denied) return denied;
    if (!r2) {
      return jsonResp({ error: "R2 binding not configured" }, 503, securityHeaders);
    }
    const name = pluginAssetUploadMatch[1].toLowerCase();
    const asset = pluginAssetUploadMatch[2];
    if (!PLUGIN_RE.test(name) || !ASSET_RE.test(asset)) {
      return jsonResp({ error: "Invalid plugin or asset name" }, 400, securityHeaders);
    }
    const buf = await request.arrayBuffer();
    if (buf.byteLength === 0) {
      return jsonResp({ error: "Empty plugin asset payload" }, 400, securityHeaders);
    }
    const digest = await sha256Hex(buf);
    const key = `plugins/${name}/${asset}`;
    await r2.put(key, buf, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { plugin: name, asset, sha256: digest },
    });
    const existing = (await readJsonKv<PublicPluginRecord>(
      kv!,
      pluginRecordKey(name),
    )) ?? {
      name,
      version: "0.1.0",
      description: "",
      kind: "blob-binary",
      protocols: [],
      repo: name,
      iroh_ticket: "",
      blake3_hash: "",
      blob_digest: `sha256:${digest}`,
      bytes: buf.byteLength,
      updated_at: nowIso,
      assets: {},
    };
    existing.assets[asset] = {
      name: asset,
      key,
      sha256: digest,
      bytes: buf.byteLength,
      content_type: "application/octet-stream",
      updated_at: nowIso,
    };
    if (!existing.blob_digest) existing.blob_digest = `sha256:${digest}`;
    if (!existing.bytes) existing.bytes = buf.byteLength;
    existing.updated_at = nowIso;
    await kv!.put(pluginRecordKey(name), JSON.stringify(existing));
    await addToIndex(kv!, PLUGINS_INDEX_KEY, name);
    return jsonResp(
      {
        ok: true,
        plugin: name,
        asset,
        sha256: digest,
        bytes: buf.byteLength,
        download_url: `${url.origin}/api/plugins/${name}/download/${asset}`,
        checksum_url: `${url.origin}/api/plugins/${name}/download/${asset}.sha256`,
      },
      200,
      securityHeaders,
    );
  }

  // GET /api/plugins/<name>/download/<asset> (and .sha256)
  const pluginDownloadMatch =
    /^\/api\/plugins\/([^/]+)\/download\/([^/]+)$/.exec(path);
  if (pluginDownloadMatch && request.method === "GET") {
    const name = pluginDownloadMatch[1].toLowerCase();
    const rawAsset = pluginDownloadMatch[2];
    if (!PLUGIN_RE.test(name)) {
      return jsonResp({ error: "Invalid plugin name" }, 400, securityHeaders);
    }
    if (rawAsset.endsWith(".sha256")) {
      const asset = rawAsset.slice(0, -".sha256".length);
      if (!ASSET_RE.test(asset) || !kv) {
        return textResp("Not found\n", 404, securityHeaders);
      }
      const rec = await readJsonKv<PublicPluginRecord>(kv, pluginRecordKey(name));
      const entry = rec?.assets?.[asset];
      if (!entry?.sha256) return textResp("Not found\n", 404, securityHeaders);
      return textResp(`${entry.sha256}  ${asset}\n`, 200, securityHeaders);
    }
    if (!ASSET_RE.test(rawAsset) || !r2) {
      return jsonResp({ error: "Plugin asset not found" }, 404, securityHeaders);
    }
    const obj = await r2.get(`plugins/${name}/${rawAsset}`);
    if (!obj) return jsonResp({ error: "Plugin asset not found" }, 404, securityHeaders);
    return binaryResp(
      obj,
      "application/octet-stream",
      rawAsset,
      obj.customMetadata?.sha256 || "",
      securityHeaders,
    );
  }

  return jsonResp({ error: "Not found" }, 404, securityHeaders);
}
