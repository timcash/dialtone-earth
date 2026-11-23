import type { KvNamespaceBinding } from "./auth.ts";

export const LIVE_STATE_KV_KEY = "live-site:dialtone.earth";

export type LiveTheme = "light" | "dark";
export type LiveView =
  | "overview"
  | "network"
  | "host"
  | "users"
  | "tests"
  | "log";

export interface LiveSiteState {
  revision: number;
  updated_at: string | null;
  updated_by: string | null;
  title: string | null;
  badge: string | null;
  banner: string | null;
  headline: string | null;
  subline: string | null;
  theme: LiveTheme | null;
  view: LiveView | null;
  network: string | null;
  tour_playing: boolean | null;
  fullscreen: boolean | null;
}

export interface LiveControlEnv {
  DIALTONE_AUTH_TOKENS?: KvNamespaceBinding;
  /** Bearer token authorizing CLI mutations to public dialtone.earth /api/live */
  LIVE_CONTROL_TOKEN?: string;
}

const VALID_THEMES = new Set<LiveTheme>(["light", "dark"]);
const VALID_VIEWS = new Set<LiveView>([
  "overview",
  "network",
  "host",
  "users",
  "tests",
  "log",
]);

export function isPublicLiveHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "dialtone.earth" ||
    normalized === "www.dialtone.earth" ||
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized.endsWith(".workers.dev")
  );
}

export function defaultLiveSiteState(revision = 0): LiveSiteState {
  return {
    revision,
    updated_at: null,
    updated_by: null,
    title: null,
    badge: null,
    banner: null,
    headline: null,
    subline: null,
    theme: null,
    view: null,
    network: null,
    tour_playing: null,
    fullscreen: null,
  };
}

function cleanString(value: unknown, maxLen: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, maxLen);
  return cleaned.length > 0 ? cleaned : null;
}

function cleanTheme(value: unknown): LiveTheme | null {
  if (typeof value !== "string") return null;
  const lowered = value.trim().toLowerCase() as LiveTheme;
  return VALID_THEMES.has(lowered) ? lowered : null;
}

function cleanView(value: unknown): LiveView | null {
  if (typeof value !== "string") return null;
  const lowered = value.trim().toLowerCase() as LiveView;
  return VALID_VIEWS.has(lowered) ? lowered : null;
}

function cleanNetworkSlug(value: unknown): string | null {
  const cleaned = cleanString(value, 64);
  if (!cleaned) return null;
  const slug = cleaned.toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug) ? slug : null;
}

function sanitizeStoredState(raw: string | null): LiveSiteState {
  if (!raw) return defaultLiveSiteState(0);
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return defaultLiveSiteState(0);
    }
    const revision =
      typeof parsed.revision === "number" &&
      Number.isFinite(parsed.revision) &&
      parsed.revision >= 0
        ? Math.floor(parsed.revision)
        : 0;
    return {
      revision,
      updated_at: cleanString(parsed.updated_at, 40),
      updated_by: cleanString(parsed.updated_by, 64),
      title: cleanString(parsed.title, 80),
      badge: cleanString(parsed.badge, 80),
      banner: cleanString(parsed.banner, 280),
      headline: cleanString(parsed.headline, 140),
      subline: cleanString(parsed.subline, 280),
      theme: cleanTheme(parsed.theme),
      view: cleanView(parsed.view),
      network: cleanNetworkSlug(parsed.network),
      tour_playing:
        typeof parsed.tour_playing === "boolean" ? parsed.tour_playing : null,
      fullscreen:
        typeof parsed.fullscreen === "boolean" ? parsed.fullscreen : null,
    };
  } catch {
    return defaultLiveSiteState(0);
  }
}

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

function isAuthorizedLiveControl(
  request: Request,
  env: LiveControlEnv,
): boolean {
  const expected = (env.LIVE_CONTROL_TOKEN ?? "").trim();
  if (!expected) return false;
  const header = (request.headers.get("Authorization") ?? "").trim();
  if (!header.toLowerCase().startsWith("bearer ")) return false;
  const provided = header.slice(7).trim();
  if (!provided) return false;
  return constantTimeEqual(provided, expected);
}

function liveJsonResponse(
  payload: unknown,
  status: number,
  securityHeaders: Record<string, string>,
): Response {
  const headers = new Headers(securityHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(payload, null, 2), { status, headers });
}

export async function handleLiveRoute(
  request: Request,
  env: LiveControlEnv,
  securityHeaders: Record<string, string>,
  nowSec: number,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/live") {
    return null;
  }

  if (!isPublicLiveHost(url.hostname)) {
    return liveJsonResponse(
      { error: "Live public control is only enabled on dialtone.earth" },
      404,
      securityHeaders,
    );
  }

  if (request.method === "GET" || request.method === "HEAD") {
    const raw = env.DIALTONE_AUTH_TOKENS
      ? await env.DIALTONE_AUTH_TOKENS.get(LIVE_STATE_KV_KEY)
      : null;
    const state = sanitizeStoredState(raw);
    const etag = `"live-rev-${state.revision}"`;
    const ifNoneMatch = (request.headers.get("If-None-Match") ?? "").trim();
    const normalizedTag = ifNoneMatch.replace(/^W\//i, "");
    if (normalizedTag && normalizedTag === etag) {
      const headers = new Headers(securityHeaders);
      headers.set("ETag", etag);
      headers.set("Cache-Control", "no-store");
      return new Response(null, { status: 304, headers });
    }
    if (request.method === "HEAD") {
      const headers = new Headers(securityHeaders);
      headers.set("Content-Type", "application/json; charset=utf-8");
      headers.set("ETag", etag);
      headers.set("Cache-Control", "no-store");
      return new Response(null, { status: 200, headers });
    }
    const resp = liveJsonResponse(state, 200, securityHeaders);
    resp.headers.set("ETag", etag);
    return resp;
  }

  if (
    request.method !== "PUT" &&
    request.method !== "PATCH" &&
    request.method !== "DELETE"
  ) {
    return liveJsonResponse(
      { error: "Method not allowed; use GET, PUT, PATCH, or DELETE" },
      405,
      securityHeaders,
    );
  }

  if (!isAuthorizedLiveControl(request, env)) {
    return liveJsonResponse(
      { error: "Bearer LIVE_CONTROL_TOKEN required" },
      401,
      securityHeaders,
    );
  }

  if (!env.DIALTONE_AUTH_TOKENS) {
    return liveJsonResponse(
      { error: "DIALTONE_AUTH_TOKENS KV binding is not configured" },
      503,
      securityHeaders,
    );
  }

  const current = sanitizeStoredState(
    await env.DIALTONE_AUTH_TOKENS.get(LIVE_STATE_KV_KEY),
  );
  const nowIso = new Date(nowSec * 1000).toISOString();

  if (request.method === "DELETE") {
    const reset: LiveSiteState = {
      ...defaultLiveSiteState(current.revision + 1),
      updated_at: nowIso,
      updated_by: "cli-reset",
    };
    await env.DIALTONE_AUTH_TOKENS.put(LIVE_STATE_KV_KEY, JSON.stringify(reset));
    return liveJsonResponse({ ok: true, state: reset }, 200, securityHeaders);
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return liveJsonResponse(
        { error: "JSON object body required" },
        400,
        securityHeaders,
      );
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return liveJsonResponse({ error: "Invalid JSON body" }, 400, securityHeaders);
  }

  if (
    "theme" in body &&
    body.theme !== null &&
    body.theme !== "" &&
    cleanTheme(body.theme) === null
  ) {
    return liveJsonResponse(
      { error: 'Invalid theme; expected "light", "dark", or empty' },
      400,
      securityHeaders,
    );
  }
  if (
    "view" in body &&
    body.view !== null &&
    body.view !== "" &&
    cleanView(body.view) === null
  ) {
    return liveJsonResponse(
      {
        error:
          'Invalid view; expected "overview", "network", "host", "users", "tests", "log", or empty',
      },
      400,
      securityHeaders,
    );
  }
  if (
    "network" in body &&
    body.network !== null &&
    body.network !== "" &&
    cleanNetworkSlug(body.network) === null
  ) {
    return liveJsonResponse(
      { error: "Invalid network slug" },
      400,
      securityHeaders,
    );
  }
  if (
    "tour_playing" in body &&
    body.tour_playing !== null &&
    typeof body.tour_playing !== "boolean"
  ) {
    return liveJsonResponse(
      { error: "Invalid tour_playing; expected boolean or null" },
      400,
      securityHeaders,
    );
  }
  if (
    "fullscreen" in body &&
    body.fullscreen !== null &&
    typeof body.fullscreen !== "boolean"
  ) {
    return liveJsonResponse(
      { error: "Invalid fullscreen; expected boolean or null" },
      400,
      securityHeaders,
    );
  }

  const base =
    request.method === "PUT"
      ? defaultLiveSiteState(current.revision)
      : { ...current };

  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(body, k);

  const next: LiveSiteState = {
    revision: current.revision + 1,
    updated_at: nowIso,
    updated_by: has("updated_by")
      ? cleanString(body.updated_by, 64) ?? "cli"
      : "cli",
    title: has("title") ? cleanString(body.title, 80) : base.title,
    badge: has("badge") ? cleanString(body.badge, 80) : base.badge,
    banner: has("banner") ? cleanString(body.banner, 280) : base.banner,
    headline: has("headline") ? cleanString(body.headline, 140) : base.headline,
    subline: has("subline") ? cleanString(body.subline, 280) : base.subline,
    theme: has("theme") ? cleanTheme(body.theme) : base.theme,
    view: has("view") ? cleanView(body.view) : base.view,
    network: has("network") ? cleanNetworkSlug(body.network) : base.network,
    tour_playing: has("tour_playing")
      ? typeof body.tour_playing === "boolean"
        ? body.tour_playing
        : null
      : base.tour_playing,
    fullscreen: has("fullscreen")
      ? typeof body.fullscreen === "boolean"
        ? body.fullscreen
        : null
      : base.fullscreen,
  };

  await env.DIALTONE_AUTH_TOKENS.put(LIVE_STATE_KV_KEY, JSON.stringify(next));
  return liveJsonResponse({ ok: true, state: next }, 200, securityHeaders);
}
