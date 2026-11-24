import { verifySessionCookie } from "./auth.ts";
import { getOwnerEmail } from "./live.ts";
import { handleRegistryRoute, renderOwnerCodePortal } from "./registry.ts";
import type {
  AccessVerificationResult,
  GatewayDeps,
  GatewayEnv,
} from "./gateway.ts";

export const STAGING_HOST = "test.dialtone.earth";

const STAGING_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

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

function stagingHeaders(
  baseSecurityHeaders: Record<string, string>,
  contentType?: string | null,
): Headers {
  const headers = new Headers(baseSecurityHeaders);
  headers.set("Content-Security-Policy", STAGING_CSP);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  if (contentType) {
    headers.set("Content-Type", contentType);
  }
  return headers;
}

function parseOriginsList(raw: string | undefined, host: string): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const map = parsed as Record<string, unknown>;
    const val = map[host] ?? map["metal.dialtone.earth"];
    const items = Array.isArray(val) ? val : typeof val === "string" ? [val] : [];
    return items
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .map((x) => x.trim().replace(/\/+$/, ""));
  } catch {
    return [];
  }
}

function parseAudForHost(raw: string | undefined, host: string): string {
  if (!raw) return "";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    const val = (parsed as Record<string, unknown>)[host];
    return typeof val === "string" ? val.trim() : "";
  } catch {
    return "";
  }
}

export interface StagingRouteArgs {
  request: Request;
  env: GatewayEnv;
  securityHeaders: Record<string, string>;
  deps: GatewayDeps;
  verifyJwt: (
    token: string,
    expectedAudience: string,
    teamDomain: string,
    fetchImpl: typeof fetch,
  ) => Promise<AccessVerificationResult>;
  fetchImpl: typeof fetch;
  nowSec: number;
}

export async function handleStagingRoute({
  request,
  env,
  securityHeaders,
  verifyJwt,
  fetchImpl,
  nowSec,
}: StagingRouteArgs): Promise<Response | null> {
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  if (host !== STAGING_HOST) {
    return null;
  }

  // Allow public read-only sign-in assets (favicon + spinning H3 globe bundle)
  // directly from env.ASSETS without touching any staging origin or private data.
  const isPublicAuthAsset =
    url.pathname === "/favicon.svg" ||
    url.pathname === "/favicon.ico" ||
    url.pathname === "/land.h3.json" ||
    url.pathname === "/auth-globe.js" ||
    url.pathname.startsWith("/assets/");
  if (
    isPublicAuthAsset &&
    (request.method === "GET" || request.method === "HEAD") &&
    env.ASSETS
  ) {
    const assetResp = await env.ASSETS.fetch(request);
    if (assetResp.status === 200 || !url.pathname.startsWith("/assets/")) {
      const outHeaders = stagingHeaders(securityHeaders, assetResp.headers.get("Content-Type"));
      return new Response(assetResp.body, { status: assetResp.status, headers: outHeaders });
    }
  }

  const ownerEmail = getOwnerEmail(env);
  let authorizedOwner = false;
  let forbiddenSubject: string | null = null;

  // 1. Owner Bearer token (for CLI / automated staging checks)
  const expectedBearer = (env.LIVE_CONTROL_TOKEN ?? "").trim();
  const authHeader = (request.headers.get("Authorization") ?? "").trim();
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    const provided = authHeader.slice(7).trim();
    if (expectedBearer && provided && constantTimeEqual(provided, expectedBearer)) {
      authorizedOwner = true;
    } else {
      return new Response(JSON.stringify({ error: "Invalid owner Bearer token" }), {
        status: 401,
        headers: stagingHeaders(securityHeaders, "application/json; charset=utf-8"),
      });
    }
  }

  // 2. Magic-link HMAC session cookie minted specifically for test.dialtone.earth
  if (!authorizedOwner) {
    const session = await verifySessionCookie(request, env, host, nowSec);
    if (session.valid && session.subject) {
      if (session.subject.toLowerCase() === ownerEmail) {
        authorizedOwner = true;
      } else {
        forbiddenSubject = session.subject.toLowerCase();
      }
    }
  }

  // 3. Cloudflare Access JWT (oakleon.cloudflareaccess.com) verified for test.dialtone.earth
  if (!authorizedOwner && !forbiddenSubject) {
    const jwt = (request.headers.get("Cf-Access-Jwt-Assertion") ?? "").trim();
    const aud = parseAudForHost(env.ACCESS_AUD_MAP, host);
    const teamDomain = (env.ACCESS_TEAM_DOMAIN ?? "").trim().replace(/\/+$/, "");
    if (jwt && aud && teamDomain) {
      const cfAuth = await verifyJwt(jwt, aud, teamDomain, fetchImpl);
      if (cfAuth.valid && cfAuth.subject) {
        if (cfAuth.subject.toLowerCase() === ownerEmail) {
          authorizedOwner = true;
        } else {
          forbiddenSubject = cfAuth.subject.toLowerCase();
        }
      }
    }
  }

  if (forbiddenSubject) {
    return new Response(
      JSON.stringify({
        error: `Forbidden: ${STAGING_HOST} staging interface is restricted to ${ownerEmail}`,
        subject: forbiddenSubject,
      }),
      {
        status: 403,
        headers: stagingHeaders(securityHeaders, "application/json; charset=utf-8"),
      },
    );
  }

  if (!authorizedOwner) {
    if (url.pathname.startsWith("/api/")) {
      return new Response(
        JSON.stringify({
          error: `Owner authentication required (${ownerEmail}) for ${STAGING_HOST}`,
        }),
        {
          status: 401,
          headers: stagingHeaders(securityHeaders, "application/json; charset=utf-8"),
        },
      );
    }
    const headers = stagingHeaders(securityHeaders);
    headers.set("Location", "/login");
    return new Response(null, { status: 302, headers });
  }

  // Owner verified: serve Private Cloudflare R2 Code Portal (/code) & private /api/code/* directly from Edge!
  if (
    (url.pathname === "/code" || url.pathname === "/code/") &&
    (request.method === "GET" || request.method === "HEAD")
  ) {
    return renderOwnerCodePortal(env, host, ownerEmail, securityHeaders);
  }
  if (url.pathname === "/api/code" || url.pathname.startsWith("/api/code/")) {
    const codeResp = await handleRegistryRoute(request, env, securityHeaders, nowSec);
    if (codeResp) {
      return codeResp;
    }
  }

  // Owner verified: proxy to the enrolled local Test Dashboard origin via /__staging/*
  const origins = parseOriginsList(env.MESH_ORIGINS_MAP, host);
  if (origins.length === 0) {
    return new Response(
      JSON.stringify({
        error: "Staging test dashboard origin is not enrolled in MESH_ORIGINS_MAP",
      }),
      {
        status: 503,
        headers: stagingHeaders(securityHeaders, "application/json; charset=utf-8"),
      },
    );
  }

  const upstreamHeaders = new Headers();
  const originToken = (env.MESH_ORIGIN_TOKEN ?? "").trim();
  if (originToken) {
    upstreamHeaders.set("Authorization", `Bearer ${originToken}`);
  }
  upstreamHeaders.set("X-Dialtone-Staging-Owner", ownerEmail);
  const accept = request.headers.get("Accept");
  if (accept) upstreamHeaders.set("Accept", accept);
  const contentType = request.headers.get("Content-Type");
  if (contentType) upstreamHeaders.set("Content-Type", contentType);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const bodyBuf = hasBody ? await request.arrayBuffer() : undefined;

  for (const origin of origins) {
    try {
      const targetUrl = `${origin}/__staging${url.pathname}${url.search}`;
      const upstream = await fetchImpl(targetUrl, {
        method: request.method,
        headers: upstreamHeaders,
        body: bodyBuf,
        redirect: "manual",
      });
      const outHeaders = stagingHeaders(
        securityHeaders,
        upstream.headers.get("Content-Type"),
      );
      const loc = upstream.headers.get("Location");
      if (loc) outHeaders.set("Location", loc);
      return new Response(upstream.body, {
        status: upstream.status,
        headers: outHeaders,
      });
    } catch {
      // try next enrolled staging origin
    }
  }

  return new Response(
    JSON.stringify({
      error: "Staging test dashboard origin unreachable (ensure `dialtone-earth dev --port 5174` and origin bridge are running)",
    }),
    {
      status: 502,
      headers: stagingHeaders(securityHeaders, "application/json; charset=utf-8"),
    },
  );
}
