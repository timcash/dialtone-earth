import {
  handleAuthRoute,
  isMagicLinkEnabledForHost,
  verifySessionCookie,
  type MagicLinkDeps,
  type MagicLinkEnv,
} from "./auth.ts";
import { handleLiveRoute, type LiveControlEnv } from "./live.ts";
import {
  buildRedactedShellAuditLog,
  listNetworkPresence,
  normalizePresenceNode,
  normalizePresenceView,
  recordUserPresence,
} from "./presence.ts";
import { redactText } from "./redact.ts";

export interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface GatewayEnv extends MagicLinkEnv, LiveControlEnv {
  ASSETS?: AssetFetcher;
  /** Cloudflare Access team domain, e.g. "https://myteam.cloudflareaccess.com" */
  ACCESS_TEAM_DOMAIN?: string;
  /** JSON map of exact hostname -> Cloudflare Access application audience ID */
  ACCESS_AUD_MAP?: string;
  /** JSON map of exact hostname -> enrolled Dialtone v0.5.5 origin URL(s) */
  MESH_ORIGINS_MAP?: string;
  /** Optional origin URL serving timcash/template /api/tests & /api/test-runs */
  TEST_DASHBOARD_ORIGIN?: string;
  /** Optional bearer token sent to enrolled Dialtone origin API */
  MESH_ORIGIN_TOKEN?: string;
  /** Optional explicit login/logout paths exposed to the UI */
  ACCESS_LOGIN_URL?: string;
  ACCESS_LOGOUT_URL?: string;
}

export interface AccessVerificationResult {
  valid: boolean;
  subject?: string;
  sessionId?: string;
  reason?: string;
}

export interface GatewayDeps extends MagicLinkDeps {
  fetchImpl?: typeof fetch;
  verifyJwt?: (
    token: string,
    expectedAudience: string,
    teamDomain: string,
    fetchImpl: typeof fetch,
  ) => Promise<AccessVerificationResult>;
}

export const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
};

/** Read-only allowlist mapping gateway routes to real Dialtone v0.5.5 + template endpoints. */
const ALLOWED_MESH_ROUTES: Record<string, string> = {
  "/api/mesh/state": "/api/mesh",
  "/api/mesh/full-state": "/api/state",
  "/api/mesh/details": "/api/details",
  "/api/mesh/plugins": "/api/plugins",
  "/api/mesh/shell/sessions": "/api/shell/sessions",
  "/api/mesh/blobs": "/api/blob",
  "/api/mesh/processes": "/api/processes",
  "/api/mesh/probe": "/api/probe",
  "/api/mesh/net": "/api/net",
  "/api/mesh/links": "/api/links",
  "/api/mesh/tests": "/api/tests",
};

const TEST_RUN_ROUTE_RE =
  /^\/api\/mesh\/test-runs\/([a-f0-9]{32})(\/log)?$/;

export async function handleGatewayRequest(
  request: Request,
  env: GatewayEnv,
  deps: GatewayDeps = {},
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const verifyJwt = deps.verifyJwt ?? verifyCloudflareAccessJwt;
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();

  if (
    url.pathname === "/login" ||
    url.pathname.startsWith("/auth/") ||
    url.pathname.startsWith("/api/auth/")
  ) {
    const authResponse = await handleAuthRoute(
      request,
      env,
      SECURITY_HEADERS,
      deps,
    );
    if (authResponse) {
      return authResponse;
    }
  }

  if (url.pathname === "/api/live") {
    const liveNowSec = deps.nowSec ? deps.nowSec() : Math.floor(Date.now() / 1000);
    const liveResponse = await handleLiveRoute(
      request,
      env,
      SECURITY_HEADERS,
      liveNowSec,
    );
    if (liveResponse) {
      return liveResponse;
    }
  }

  if (!url.pathname.startsWith("/api/")) {
    if (env.ASSETS) {
      const assetResponse = await env.ASSETS.fetch(request);
      return withSecurityHeaders(assetResponse);
    }
    return jsonResponse({ error: "Not found" }, 404);
  }

  const isPresenceUpdate =
    url.pathname === "/api/mesh/presence" && request.method === "POST";

  if (
    !isPresenceUpdate &&
    request.method !== "GET" &&
    request.method !== "HEAD"
  ) {
    return jsonResponse({ error: "Method not allowed; gateway is read-only" }, 405);
  }

  const audMap = parseStringMap(env.ACCESS_AUD_MAP);
  const originsMap = parseOriginsMap(env.MESH_ORIGINS_MAP);
  const expectedAud = audMap[host] ?? "";
  const origins = originsMap[host] ?? [];
  const teamDomain = (env.ACCESS_TEAM_DOMAIN ?? "").trim().replace(/\/+$/, "");
  const assertion = extractAccessAssertion(request);
  const magicLinkEnabled = isMagicLinkEnabledForHost(env, host);

  const nowSec = deps.nowSec ? deps.nowSec() : Math.floor(Date.now() / 1000);
  let auth: AccessVerificationResult = { valid: false, reason: "unauthenticated" };
  let gatewayMode = magicLinkEnabled ? "dialtone-magic-link" : "cloudflare-access";

  const sessionAuth = await verifySessionCookie(request, env, host, nowSec);
  if (sessionAuth.valid) {
    auth = sessionAuth;
    gatewayMode = "dialtone-magic-link";
  } else if (assertion && expectedAud && teamDomain) {
    auth = await verifyJwt(assertion, expectedAud, teamDomain, fetchImpl);
    if (auth.valid) {
      gatewayMode = "cloudflare-access";
      auth.sessionId = `cf-${auth.subject ?? "user"}`;
    }
  } else if (!magicLinkEnabled && assertion && (!expectedAud || !teamDomain)) {
    auth = { valid: false, reason: "host_not_enrolled" };
  }

  const loginUrl =
    (env.ACCESS_LOGIN_URL ?? "").trim() ||
    (magicLinkEnabled ? "/login" : null);
  const logoutUrl =
    (env.ACCESS_LOGOUT_URL ?? "").trim() ||
    (gatewayMode === "dialtone-magic-link"
      ? "/auth/logout"
      : "/cdn-cgi/access/logout");

  if (url.pathname === "/api/session") {
    if (auth.valid && origins.length > 0) {
      const subject = auth.subject ?? "verified-user";
      const sessionId = auth.sessionId ?? `sess-${subject}`;
      await recordUserPresence(env.DIALTONE_AUTH_TOKENS, {
        request,
        host,
        subject,
        sessionId,
        nowSec,
        preserveExistingView: true,
      });
      return jsonResponse(
        {
          authenticated: true,
          mode: "live",
          network: networkLabelForHost(host),
          hostname: host,
          subject,
          session_id: sessionId,
          origin_count: origins.length,
          gateway: gatewayMode,
          login_url: loginUrl,
          logout_url: logoutUrl,
        },
        200,
      );
    }
    return jsonResponse(
      {
        authenticated: false,
        mode: "simulated",
        network: null,
        hostname: host,
        gateway: gatewayMode,
        login_url: loginUrl,
        logout_url: logoutUrl,
        capabilities: [
          "tour",
          "networks",
          "hosts",
          "users",
          "plugins",
          "blobs",
          "recovery",
          "resources",
          "tests",
          "logs",
        ],
      },
      200,
    );
  }

  if (url.pathname === "/api/mesh/presence") {
    if (!auth.valid) {
      return jsonResponse(
        {
          error: magicLinkEnabled
            ? "Sign-in required"
            : "Cloudflare Access sign-in required",
          reason: auth.reason ?? "unauthenticated",
        },
        401,
      );
    }
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = await request.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      body = {};
    }
    const subject = auth.subject ?? "verified-user";
    const sessionId = auth.sessionId ?? `sess-${subject}`;
    const record = await recordUserPresence(env.DIALTONE_AUTH_TOKENS, {
      request,
      host,
      subject,
      sessionId,
      viewingView: normalizePresenceView(body.view),
      viewingNode: normalizePresenceNode(body.node),
      nowSec,
    });
    return jsonResponse({ ok: true, presence: record }, 200);
  }

  if (url.pathname === "/api/mesh/users") {
    if (!auth.valid) {
      return jsonResponse(
        {
          error: magicLinkEnabled
            ? "Sign-in required"
            : "Cloudflare Access sign-in required",
          reason: auth.reason ?? "unauthenticated",
        },
        401,
      );
    }
    const subject = auth.subject ?? "verified-user";
    const sessionId = auth.sessionId ?? `sess-${subject}`;
    const currentPresence = await recordUserPresence(env.DIALTONE_AUTH_TOKENS, {
      request,
      host,
      subject,
      sessionId,
      nowSec,
      preserveExistingView: true,
    });
    const [sessionsPayload, fullStatePayload] =
      origins.length > 0
        ? await Promise.all([
            fetchJsonFromOrigins(
              origins,
              "/api/shell/sessions",
              env.MESH_ORIGIN_TOKEN,
              fetchImpl,
            ),
            fetchJsonFromOrigins(
              origins,
              "/api/state",
              env.MESH_ORIGIN_TOKEN,
              fetchImpl,
            ),
          ])
        : [null, null];

    const defaultNode =
      typeof fullStatePayload?.node === "string" && fullStatePayload.node
        ? fullStatePayload.node
        : networkLabelForHost(host);

    const shellAuditLog = buildRedactedShellAuditLog({
      sessionsPayload,
      fullStatePayload,
      defaultNode,
      defaultUser: subject,
      nowSec,
    });
    const users = await listNetworkPresence(
      env.DIALTONE_AUTH_TOKENS,
      host,
      currentPresence,
      shellAuditLog,
      nowSec,
    );

    return jsonResponse(
      {
        hostname: host,
        network: networkLabelForHost(host),
        generated_at: new Date(nowSec * 1000).toISOString(),
        redaction_policy: "keys-and-passwords-redacted",
        users,
        shell_audit_log: shellAuditLog,
      },
      200,
    );
  }

  const upstreamPath = resolveAllowedUpstreamPath(url.pathname, url.search);
  if (!upstreamPath) {
    return jsonResponse({ error: "Unknown gateway endpoint" }, 404);
  }

  // Default-deny: unauthenticated, wrong audience, or unenrolled hostname performs ZERO origin fetches.
  if (!auth.valid) {
    return jsonResponse(
      {
        error: magicLinkEnabled ? "Sign-in required" : "Cloudflare Access sign-in required",
        reason: auth.reason ?? "unauthenticated",
      },
      401,
    );
  }

  if (origins.length === 0) {
    return jsonResponse(
      {
        error: "No Dialtone mesh origin enrolled for this hostname",
      },
      503,
    );
  }

  const isTestRoute =
    url.pathname === "/api/mesh/tests" ||
    url.pathname.startsWith("/api/mesh/test-runs/");
  const targetOrigins =
    isTestRoute && env.TEST_DASHBOARD_ORIGIN?.trim()
      ? [env.TEST_DASHBOARD_ORIGIN.trim(), ...origins]
      : origins;

  return proxyToEnrolledOrigins(
    targetOrigins,
    upstreamPath,
    env.MESH_ORIGIN_TOKEN,
    fetchImpl,
  );
}

export function resolveAllowedUpstreamPath(
  pathname: string,
  search: string,
): string | null {
  if (Object.hasOwn(ALLOWED_MESH_ROUTES, pathname)) {
    const mapped = ALLOWED_MESH_ROUTES[pathname];
    if (pathname === "/api/mesh/details" && search) {
      const params = new URLSearchParams(search);
      const nodeId = params.get("node_id") ?? "";
      if (/^[a-zA-Z0-9_-]{1,128}$/.test(nodeId)) {
        return `${mapped}?node_id=${encodeURIComponent(nodeId)}`;
      }
    }
    return mapped;
  }

  const runMatch = TEST_RUN_ROUTE_RE.exec(pathname);
  if (runMatch) {
    return `/api/test-runs/${runMatch[1]}${runMatch[2] ?? ""}`;
  }
  return null;
}

async function proxyToEnrolledOrigins(
  origins: string[],
  upstreamPath: string,
  bearerToken: string | undefined,
  fetchImpl: typeof fetch,
): Promise<Response> {
  let lastStatus = 502;
  for (const rawOrigin of origins) {
    let targetUrl: URL;
    try {
      targetUrl = new URL(upstreamPath, rawOrigin);
    } catch {
      continue;
    }
    if (targetUrl.protocol !== "https:" && targetUrl.hostname !== "127.0.0.1") {
      continue;
    }

    const headers = new Headers({
      Accept: "application/json, text/plain",
    });
    if (bearerToken && bearerToken.trim() !== "") {
      headers.set("Authorization", `Bearer ${bearerToken.trim()}`);
    }

    try {
      const upstream = await fetchImpl(targetUrl.toString(), {
        method: "GET",
        headers,
        redirect: "manual",
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        lastStatus = 502;
        continue;
      }
      if (upstream.status >= 500) {
        lastStatus = upstream.status;
        continue;
      }
      if (upstreamPath === "/api/shell/sessions" && upstream.ok) {
        try {
          const parsed = (await upstream.json()) as Record<string, unknown>;
          if (Array.isArray(parsed.sessions)) {
            parsed.sessions = parsed.sessions.map((entry) => {
              if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
                return entry;
              }
              const s = { ...(entry as Record<string, unknown>) };
              if (typeof s.last_command === "string") {
                s.last_command = redactText(s.last_command);
              }
              if (typeof s.last_output === "string") {
                s.last_output = redactText(s.last_output);
              }
              return s;
            });
          }
          return jsonResponse(parsed, upstream.status);
        } catch {
          // Fall through to standard proxy error if invalid JSON
        }
      }
      const responseHeaders = new Headers(SECURITY_HEADERS);
      responseHeaders.set("Cache-Control", "private, no-store");
      responseHeaders.set(
        "Content-Type",
        upstream.headers.get("Content-Type") ?? "application/json; charset=utf-8",
      );
      return new Response(upstream.body, {
        status: upstream.status,
        headers: responseHeaders,
      });
    } catch {
      lastStatus = 502;
      continue;
    }
  }
  return jsonResponse(
    { error: "All enrolled Dialtone mesh origins are unavailable" },
    lastStatus,
  );
}

async function fetchJsonFromOrigins(
  origins: string[],
  upstreamPath: string,
  bearerToken: string | undefined,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown> | null> {
  const resp = await proxyToEnrolledOrigins(
    origins,
    upstreamPath,
    bearerToken,
    fetchImpl,
  );
  if (!resp.ok) return null;
  try {
    const parsed: unknown = await resp.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore non-JSON upstream payloads
  }
  return null;
}

export async function verifyCloudflareAccessJwt(
  token: string,
  expectedAudience: string,
  teamDomain: string,
  fetchImpl: typeof fetch,
): Promise<AccessVerificationResult> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { valid: false, reason: "malformed_jwt" };
  }
  let header: { alg?: string; kid?: string };
  let payload: {
    iss?: string;
    aud?: string | string[];
    exp?: number;
    nbf?: number;
    email?: string;
    sub?: string;
  };
  try {
    header = JSON.parse(decodeBase64UrlToString(parts[0])) as {
      alg?: string;
      kid?: string;
    };
    payload = JSON.parse(decodeBase64UrlToString(parts[1])) as {
      iss?: string;
      aud?: string | string[];
      exp?: number;
      nbf?: number;
      email?: string;
      sub?: string;
    };
  } catch {
    return { valid: false, reason: "invalid_json" };
  }

  if (header.alg !== "RS256" || !header.kid) {
    return { valid: false, reason: "unsupported_alg" };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= nowSec) {
    return { valid: false, reason: "expired" };
  }
  if (typeof payload.nbf === "number" && payload.nbf > nowSec + 30) {
    return { valid: false, reason: "not_yet_valid" };
  }
  if (payload.iss !== teamDomain) {
    return { valid: false, reason: "wrong_issuer" };
  }
  const audList = Array.isArray(payload.aud)
    ? payload.aud
    : typeof payload.aud === "string"
      ? [payload.aud]
      : [];
  if (!audList.includes(expectedAudience)) {
    return { valid: false, reason: "wrong_audience" };
  }
  const subject = payload.email || payload.sub;
  if (!subject) {
    return { valid: false, reason: "missing_subject" };
  }

  try {
    const certsResp = await fetchImpl(`${teamDomain}/cdn-cgi/access/certs`, {
      method: "GET",
      redirect: "manual",
    });
    if (!certsResp.ok) {
      return { valid: false, reason: "jwks_unavailable" };
    }
    const jwks = (await certsResp.json()) as {
      keys?: Array<JsonWebKey & { kid?: string }>;
    };
    const keyJwk = jwks.keys?.find((k) => k.kid === header.kid);
    if (!keyJwk) {
      return { valid: false, reason: "unknown_kid" };
    }
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      keyJwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signature = decodeBase64UrlToBytes(parts[2]);
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      signature,
      signingInput,
    );
    return ok ? { valid: true, subject } : { valid: false, reason: "bad_signature" };
  } catch {
    return { valid: false, reason: "verification_error" };
  }
}

function extractAccessAssertion(request: Request): string {
  const headerVal = request.headers.get("Cf-Access-Jwt-Assertion")?.trim();
  if (headerVal) return headerVal;
  const cookieHeader = request.headers.get("Cookie") ?? "";
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === "CF_Authorization") {
      return rest.join("=").trim();
    }
  }
  return "";
}

function networkLabelForHost(host: string): string {
  const suffix = ".dialtone.earth";
  if (host.endsWith(suffix)) {
    return host.slice(0, -suffix.length);
  }
  return host;
}

function parseStringMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && v.trim() !== "") {
        out[k.toLowerCase()] = v.trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

function parseOriginsMap(raw: string | undefined): Record<string, string[]> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && v.trim() !== "") {
        out[k.toLowerCase()] = [v.trim()];
      } else if (Array.isArray(v)) {
        const list = v
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
        if (list.length > 0) {
          out[k.toLowerCase()] = list;
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

function decodeBase64UrlToBytes(input: string): Uint8Array<ArrayBuffer> {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((input.length + 3) % 4);
  const binary = atob(padded);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeBase64UrlToString(input: string): string {
  return new TextDecoder().decode(decodeBase64UrlToBytes(input));
}

function jsonResponse(payload: unknown, status: number): Response {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "private, no-store");
  return new Response(JSON.stringify(payload), { status, headers });
}

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(k)) {
      headers.set(k, v);
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
