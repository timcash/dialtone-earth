import type { KvNamespaceBinding, MagicLinkEnv } from "./auth.ts";
import { authorizeOwnerRequest, isPublicLiveHost } from "./live.ts";

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

export interface RegistryEnv extends MagicLinkEnv {
  DIALTONE_AUTH_TOKENS?: KvNamespaceBinding;
  DIALTONE_REGISTRY?: R2BucketBinding;
  LIVE_CONTROL_TOKEN?: string;
  OWNER_EMAIL?: string;
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
const CHANNEL_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;

const CODE_INDEX_KEY = "registry:code:index";
const PLUGINS_INDEX_KEY = "registry:plugins:index";
const codeRepoKey = (repo: string) => `registry:code:repo:${repo}`;
const releasesIndexKey = (repo: string) => `registry:releases:index:${repo}`;
const releaseRecordKey = (repo: string, tag: string) =>
  `registry:releases:item:${repo}:${tag}`;
const releaseChannelsIndexKey = (repo: string) =>
  `registry:releases:channels:${repo}`;
const releaseChannelKey = (repo: string, channel: string) =>
  `registry:releases:channel:${repo}:${channel}`;
const pluginRecordKey = (name: string) => `registry:plugins:item:${name}`;

export interface ReleaseChannelRecord {
  repo: string;
  channel: string;
  tag: string;
  sha: string;
  updated_at: string;
  promoted_by: string;
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
  extraHeaders?: Record<string, string>,
): Response {
  const headers = new Headers(securityHeaders);
  headers.set("Content-Type", contentType || "application/octet-stream");
  headers.set("Content-Disposition", `attachment; filename="${filename}"`);
  headers.set("Cache-Control", "no-store");
  if (sha256) headers.set("X-Dialtone-Sha256", sha256);
  if (typeof obj.size === "number") headers.set("Content-Length", String(obj.size));
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (v) headers.set(k, v);
    }
  }
  return new Response(obj.body as BodyInit, { status: 200, headers });
}

function escapeCodeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#039;";
      default:
        return ch;
    }
  });
}

function formatCodeBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export async function renderOwnerCodePortal(
  env: RegistryEnv,
  host: string,
  ownerEmail: string,
  securityHeaders: Record<string, string>,
): Promise<Response> {
  const kv = env.DIALTONE_AUTH_TOKENS;
  const names = kv ? ((await readJsonKv<string[]>(kv, CODE_INDEX_KEY)) ?? []) : [];
  const records = kv
    ? (
        await Promise.all(
          names.map((name) => readJsonKv<StoredRepoRecord>(kv, codeRepoKey(name))),
        )
      ).filter((r): r is StoredRepoRecord => Boolean(r))
    : [];

  const repoCards =
    records.length === 0
      ? `<section class="panel"><p class="muted">No private repositories pushed to Cloudflare R2 yet. Push with <code>dialtone-earth code push --repo dialtone-earth</code>.</p></section>`
      : records
          .map((repo) => {
            const branches = Object.values(repo.branches || {});
            const archives = Object.values(repo.archives || {});
            const history = (repo.history || []).slice(0, 8);
            const branchRows = branches
              .map(
                (b) => `
                  <tr>
                    <td><strong>${escapeCodeHtml(b.branch)}</strong></td>
                    <td><code>${escapeCodeHtml((b.sha || "").slice(0, 10))}</code></td>
                    <td>${escapeCodeHtml(b.subject || "")}</td>
                    <td>${escapeCodeHtml(formatCodeBytes(b.bundle_bytes))}</td>
                    <td>${escapeCodeHtml(b.pushed_at || "")}</td>
                    <td><a class="chip" href="/api/code/${encodeURIComponent(repo.name)}/bundle?branch=${encodeURIComponent(b.branch)}">bundle ⬇</a></td>
                  </tr>`,
              )
              .join("");
            const archiveLinks = archives
              .map(
                (a) =>
                  `<a class="chip" href="/api/code/${encodeURIComponent(repo.name)}/archive/${encodeURIComponent(a.filename)}">${escapeCodeHtml(a.filename)} (${escapeCodeHtml(formatCodeBytes(a.bytes))}) ⬇</a>`,
              )
              .join("");
            const historyRows = history
              .map(
                (h) => `
                  <li>
                    <code>${escapeCodeHtml((h.sha || "").slice(0, 10))}</code>
                    <span class="tag">${escapeCodeHtml(h.branch)}</span>
                    <span>${escapeCodeHtml(h.subject || "")}</span>
                    <span class="muted">${escapeCodeHtml(h.pushed_at || "")}</span>
                  </li>`,
              )
              .join("");

            return `
              <section class="panel">
                <div class="panel-head">
                  <div>
                    <span class="kicker">PRIVATE R2 REPO</span>
                    <h2>${escapeCodeHtml(repo.name)}</h2>
                  </div>
                  <div class="meta-right">
                    <span class="pill-ok">HEAD ${escapeCodeHtml((repo.head_sha || "").slice(0, 10))}</span>
                    <span class="muted">branch: ${escapeCodeHtml(repo.default_branch || "main")}</span>
                  </div>
                </div>
                <p class="subject">${escapeCodeHtml(repo.head_subject || "")}</p>
                <div class="actions-row">
                  <a class="chip is-hi" href="/api/code/${encodeURIComponent(repo.name)}/bundle?branch=${encodeURIComponent(repo.default_branch || "main")}">download git bundle ⬇</a>
                  ${archiveLinks}
                  <a class="chip" href="/api/code/${encodeURIComponent(repo.name)}" target="_blank" rel="noreferrer">json ↗</a>
                </div>
                <pre class="cmd"><code># Clone or pull directly from Cloudflare R2 (owner Bearer token required)
dialtone-earth code pull --repo ${escapeCodeHtml(repo.name)} --url https://${escapeCodeHtml(host)}
dialtone-earth code push --repo ${escapeCodeHtml(repo.name)}</code></pre>
                ${
                  branchRows
                    ? `<table>
                        <thead><tr><th>BRANCH</th><th>SHA</th><th>COMMIT</th><th>BUNDLE</th><th>PUSHED</th><th>DOWNLOAD</th></tr></thead>
                        <tbody>${branchRows}</tbody>
                      </table>`
                    : ""
                }
                ${
                  historyRows
                    ? `<div class="history-wrap"><div class="kicker">RECENT PUSHES</div><ul class="history">${historyRows}</ul></div>`
                    : ""
                }
              </section>`;
          })
          .join("\n");

  const html = `<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="dark" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <title>DIALTONE // CODE — ${escapeCodeHtml(host)}</title>
    <style>
      *, *::before, *::after { box-sizing: border-box; }
      :root {
        --bg: #080808; --panel: #101010; --line: #262626; --line-hi: #444;
        --ink: #f0f0f0; --muted: #8a8a8a; --ok: #36d66b;
      }
      html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--ink); font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
      header.topbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--line); background: #0c0c0c; position: sticky; top: 0; z-index: 5; }
      .brand { display: flex; align-items: center; gap: 10px; font-size: 13px; font-weight: 700; letter-spacing: 0.06em; }
      .pill-ok { font-size: 11px; color: var(--ok); border: 1px solid rgba(54,214,107,0.5); padding: 2px 7px; }
      nav.nav { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border: 1px solid var(--line-hi); background: #141414; color: var(--ink); text-decoration: none; font-size: 11px; }
      .chip:hover { border-color: #fff; background: #1c1c1c; }
      .chip.is-hi { background: #f0f0f0; color: #000; border-color: #f0f0f0; font-weight: 700; }
      .chip.is-hi:hover { background: #fff; }
      main { max-width: 1180px; margin: 0 auto; padding: 18px 16px 40px; display: flex; flex-direction: column; gap: 16px; }
      .panel { background: var(--panel); border: 1px solid var(--line); padding: 16px; }
      .panel-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 10px; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
      .panel-head h2 { margin: 2px 0 0; font-size: 18px; }
      .kicker { font-size: 10px; letter-spacing: 0.08em; color: var(--muted); }
      .meta-right { display: flex; align-items: center; gap: 10px; font-size: 11px; }
      .subject { margin: 10px 0 12px; color: #d6d6d6; font-size: 13px; }
      .muted { color: var(--muted); font-size: 11px; }
      .actions-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
      pre.cmd { margin: 0 0 14px; padding: 10px 12px; background: #050505; border: 1px solid var(--line); overflow-x: auto; font-size: 12px; color: #d8d8d8; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 6px; }
      th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }
      th { font-size: 10px; letter-spacing: 0.08em; color: var(--muted); }
      .history-wrap { margin-top: 14px; }
      ul.history { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
      ul.history li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; padding: 4px 0; border-bottom: 1px solid #1b1b1b; }
      .tag { font-size: 10px; border: 1px solid var(--line-hi); padding: 1px 5px; color: var(--muted); }
    </style>
  </head>
  <body>
    <header class="topbar">
      <div class="brand">
        <span>DIALTONE // CODE</span>
        <span class="pill-ok">R2 PRIVATE · ${escapeCodeHtml(ownerEmail)}</span>
      </div>
      <nav class="nav">
        <a class="chip" href="/">test dashboard</a>
        <a class="chip is-hi" href="/code">code</a>
        <a class="chip" href="/logs">logs</a>
        <a class="chip" href="/api/code" target="_blank" rel="noreferrer">api/code ↗</a>
        <a class="chip" href="/auth/logout">sign out</a>
      </nav>
    </header>
    <main>
      ${repoCards}
    </main>
  </body>
</html>`;

  const headers = new Headers(securityHeaders);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return new Response(html, { status: 200, headers });
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

  if (!isPublicLiveHost(url.hostname) && !(isCode && url.hostname.toLowerCase() === "test.dialtone.earth")) {
    return jsonResp(
      { error: "Dialtone registry is served from dialtone.earth" },
      404,
      securityHeaders,
    );
  }

  const kv = env.DIALTONE_AUTH_TOKENS;
  const r2 = env.DIALTONE_REGISTRY;
  const nowIso = new Date(nowSec * 1000).toISOString();
  const host = url.hostname.toLowerCase();

  const requireOwnerAuth = async (needKv = true): Promise<Response | null> => {
    const auth = await authorizeOwnerRequest(request, env, host, nowSec);
    if (!auth.ok) {
      return jsonResp(
        { error: auth.error || "Owner authentication required" },
        auth.status,
        securityHeaders,
      );
    }
    if (needKv && !kv) {
      return jsonResp(
        { error: "DIALTONE_AUTH_TOKENS KV binding is not configured" },
        503,
        securityHeaders,
      );
    }
    return null;
  };

  // ===========================================================================
  // 1. PRIVATE OWNER-ONLY CODE / GIT REPOSITORY STORAGE (/api/code/*)
  //    Only the owner (timcash@gmail.com session or owner Bearer token) may
  //    list, inspect, clone, pull, archive, or push git repositories.
  // ===========================================================================
  if (isCode) {
    const denied = await requireOwnerAuth(false);
    if (denied) return denied;
  }

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
    const denied = await requireOwnerAuth(true);
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
    const shallow = cleanText(request.headers.get("X-Dialtone-Shallow") || "", 512);

    const buf = await request.arrayBuffer();
    if (buf.byteLength === 0) {
      return jsonResp({ error: "Empty git bundle payload" }, 400, securityHeaders);
    }
    const bundleSha256 = await sha256Hex(buf);
    const bundleKey = `code/${repo}/bundles/${sha}.bundle`;
    await r2.put(bundleKey, buf, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { repo, branch, sha, sha256: bundleSha256, ...(shallow ? { shallow } : {}) },
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
      {
        "X-Dialtone-Branch": obj.customMetadata?.branch || rec.default_branch || "main",
        ...(obj.customMetadata?.shallow ? { "X-Dialtone-Shallow": obj.customMetadata.shallow } : {}),
      },
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
      const denied = await requireOwnerAuth(true);
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
  // 2. RELEASES, CHANNELS & AUTO-UPDATE FEEDS
  //    - /api/releases/<repo>
  //    - /api/releases/<repo>/channels
  //    - /api/releases/<repo>/channel/<channel>  (GET public, POST/PUT owner-only)
  //    - /api/releases/<repo>/<tag>
  //    - /api/releases/<repo>/<tag>/assets/<asset>
  //    - /releases/<repo>/latest/download/<asset>
  //    - /releases/<repo>/channel/<channel>/latest/download/<asset>
  //    - /releases/<repo>/channel/<channel>/download/<tag>/<asset>
  //    - /releases/<repo>/download/<tag>/<asset>
  // ===========================================================================
  const resolveAssetContentType = (name: string): string => {
    if (name.endsWith(".json")) return "application/json; charset=utf-8";
    if (name.endsWith(".sig") || name.endsWith(".sha256") || name.endsWith(".txt")) {
      return "text/plain; charset=utf-8";
    }
    return "application/octet-stream";
  };

  const resolveLatestTagForRepo = async (
    repo: string,
    channel?: string,
  ): Promise<string | null> => {
    if (!kv) return null;
    const chName = (channel || "latest").toLowerCase();
    const explicit = await readJsonKv<ReleaseChannelRecord>(
      kv,
      releaseChannelKey(repo, chName),
    );
    if (explicit?.tag && TAG_RE.test(explicit.tag)) {
      return explicit.tag;
    }
    if (channel && chName !== "latest" && chName !== "stable") {
      // Explicit non-default channel (e.g. "test") must be published explicitly.
      return null;
    }
    // Fallback for "latest": pick most recently created release tag.
    const tags = (await readJsonKv<string[]>(kv, releasesIndexKey(repo))) ?? [];
    if (tags.length === 0) return null;
    const recs = (
      await Promise.all(
        tags.map((t) => readJsonKv<StoredReleaseRecord>(kv, releaseRecordKey(repo, t))),
      )
    ).filter((r): r is StoredReleaseRecord => Boolean(r));
    recs.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return recs[0]?.tag ?? null;
  };

  const serveReleaseAsset = async (
    repo: string,
    tag: string,
    rawAsset: string,
  ): Promise<Response> => {
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
      resolveAssetContentType(rawAsset),
      rawAsset,
      obj.customMetadata?.sha256 || "",
      securityHeaders,
      { "X-Dialtone-Release-Tag": tag },
    );
  };

  // GET /api/releases/<repo>/channels
  const relChannelsListMatch = /^\/api\/releases\/([^/]+)\/channels$/.exec(path);
  if (relChannelsListMatch && request.method === "GET") {
    const repo = relChannelsListMatch[1];
    if (!REPO_RE.test(repo)) {
      return jsonResp({ error: "Invalid repo name" }, 400, securityHeaders);
    }
    if (!kv) return jsonResp({ repo, channels: {} }, 200, securityHeaders);
    const names = (await readJsonKv<string[]>(kv, releaseChannelsIndexKey(repo))) ?? [];
    const entries = await Promise.all(
      names.map((ch) => readJsonKv<ReleaseChannelRecord>(kv, releaseChannelKey(repo, ch))),
    );
    const channels: Record<string, ReleaseChannelRecord & { manifest_url: string; release_base: string }> = {};
    for (const rec of entries) {
      if (!rec) continue;
      const base =
        rec.channel === "latest" || rec.channel === "stable"
          ? `${url.origin}/releases/${repo}`
          : `${url.origin}/releases/${repo}/channel/${rec.channel}`;
      channels[rec.channel] = {
        ...rec,
        release_base: base,
        manifest_url: `${base}/latest/download/dialtone-release.json`,
      };
    }
    return jsonResp({ repo, channels }, 200, securityHeaders);
  }

  // GET / POST / PUT /api/releases/<repo>/channel/<channel>
  const relChannelMatch = /^\/api\/releases\/([^/]+)\/channel\/([^/]+)$/.exec(path);
  if (relChannelMatch) {
    const repo = relChannelMatch[1];
    const channel = relChannelMatch[2].toLowerCase();
    if (!REPO_RE.test(repo) || !CHANNEL_RE.test(channel)) {
      return jsonResp({ error: "Invalid repo or channel name" }, 400, securityHeaders);
    }
    if (request.method === "GET") {
      if (!kv) return jsonResp({ error: "Channel not found" }, 404, securityHeaders);
      const rec = await readJsonKv<ReleaseChannelRecord>(kv, releaseChannelKey(repo, channel));
      if (!rec) {
        return jsonResp({ error: `No release published on channel ${channel}` }, 404, securityHeaders);
      }
      const base =
        channel === "latest" || channel === "stable"
          ? `${url.origin}/releases/${repo}`
          : `${url.origin}/releases/${repo}/channel/${channel}`;
      return jsonResp(
        {
          ...rec,
          release_base: base,
          manifest_url: `${base}/latest/download/dialtone-release.json`,
        },
        200,
        securityHeaders,
      );
    }
    if (request.method === "POST" || request.method === "PUT") {
      const denied = await requireOwnerAuth(true);
      if (denied) return denied;
      let body: Record<string, unknown> = {};
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        // empty JSON allowed if invalid
      }
      let targetTag = cleanText(body.tag, 64);
      const fromChannel = cleanText(body.from_channel, 32).toLowerCase();
      if (!targetTag && fromChannel) {
        if (!CHANNEL_RE.test(fromChannel)) {
          return jsonResp({ error: "Invalid from_channel" }, 400, securityHeaders);
        }
        const sourceRec = await readJsonKv<ReleaseChannelRecord>(
          kv!,
          releaseChannelKey(repo, fromChannel),
        );
        if (!sourceRec?.tag) {
          return jsonResp(
            { error: `Source channel ${fromChannel} has no active release` },
            404,
            securityHeaders,
          );
        }
        targetTag = sourceRec.tag;
      }
      if (!TAG_RE.test(targetTag)) {
        return jsonResp({ error: "Valid tag (vX.Y.Z) or from_channel is required" }, 400, securityHeaders);
      }
      const rel = await readJsonKv<StoredReleaseRecord>(kv!, releaseRecordKey(repo, targetTag));
      if (!rel) {
        return jsonResp(
          { error: `Release ${repo}@${targetTag} not found` },
          404,
          securityHeaders,
        );
      }
      const rec: ReleaseChannelRecord = {
        repo,
        channel,
        tag: targetTag,
        sha: rel.sha || "",
        updated_at: nowIso,
        promoted_by: cleanText(body.promoted_by || (fromChannel ? `promote:${fromChannel}` : "owner"), 80),
      };
      await kv!.put(releaseChannelKey(repo, channel), JSON.stringify(rec));
      await addToIndex(kv!, releaseChannelsIndexKey(repo), channel);
      const base =
        channel === "latest" || channel === "stable"
          ? `${url.origin}/releases/${repo}`
          : `${url.origin}/releases/${repo}/channel/${channel}`;
      return jsonResp(
        {
          ok: true,
          channel: rec,
          release_base: base,
          manifest_url: `${base}/latest/download/dialtone-release.json`,
        },
        200,
        securityHeaders,
      );
    }
  }

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
      const denied = await requireOwnerAuth(true);
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
    const denied = await requireOwnerAuth(true);
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

  // Public dialtone auto-updater & installer download endpoints:
  //   GET /releases/<repo>/latest/download/<asset>
  //   GET /releases/<repo>/channel/<channel>/latest/download/<asset>
  //   GET /releases/<repo>/channel/<channel>/download/<tag>/<asset>
  //   GET /releases/<repo>/download/<tag>/<asset>  (and <asset>.sha256)
  const relChannelLatestMatch =
    /^\/releases\/([^/]+)\/channel\/([^/]+)\/latest\/download\/([^/]+)$/.exec(path);
  if (relChannelLatestMatch && request.method === "GET") {
    const repo = relChannelLatestMatch[1];
    const channel = relChannelLatestMatch[2].toLowerCase();
    const rawAsset = relChannelLatestMatch[3];
    if (!REPO_RE.test(repo) || !CHANNEL_RE.test(channel)) {
      return jsonResp({ error: "Invalid repo or channel" }, 400, securityHeaders);
    }
    const tag = await resolveLatestTagForRepo(repo, channel);
    if (!tag) {
      return jsonResp({ error: `No release published on channel ${channel}` }, 404, securityHeaders);
    }
    return serveReleaseAsset(repo, tag, rawAsset);
  }

  const relChannelTagMatch =
    /^\/releases\/([^/]+)\/channel\/([^/]+)\/download\/([^/]+)\/([^/]+)$/.exec(path);
  if (relChannelTagMatch && request.method === "GET") {
    const repo = relChannelTagMatch[1];
    const channel = relChannelTagMatch[2].toLowerCase();
    const tag = relChannelTagMatch[3];
    const rawAsset = relChannelTagMatch[4];
    if (!REPO_RE.test(repo) || !CHANNEL_RE.test(channel)) {
      return jsonResp({ error: "Invalid repo or channel" }, 400, securityHeaders);
    }
    return serveReleaseAsset(repo, tag, rawAsset);
  }

  const relLatestDownloadMatch =
    /^\/releases\/([^/]+)\/latest\/download\/([^/]+)$/.exec(path);
  if (relLatestDownloadMatch && request.method === "GET") {
    const repo = relLatestDownloadMatch[1];
    const rawAsset = relLatestDownloadMatch[2];
    if (!REPO_RE.test(repo)) {
      return jsonResp({ error: "Invalid repo" }, 400, securityHeaders);
    }
    const tag = await resolveLatestTagForRepo(repo);
    if (!tag) {
      return jsonResp({ error: "No release published" }, 404, securityHeaders);
    }
    return serveReleaseAsset(repo, tag, rawAsset);
  }

  const relDownloadMatch =
    /^\/releases\/([^/]+)\/download\/([^/]+)\/([^/]+)$/.exec(path);
  if (relDownloadMatch && request.method === "GET") {
    const repo = relDownloadMatch[1];
    const tag = relDownloadMatch[2];
    const rawAsset = relDownloadMatch[3];
    return serveReleaseAsset(repo, tag, rawAsset);
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
      const denied = await requireOwnerAuth(true);
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
    const denied = await requireOwnerAuth(true);
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
