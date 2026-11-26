import { clearUserPresence } from "./presence.ts";

export interface KvNamespaceBinding {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list?(options?: {
    prefix?: string;
  }): Promise<{ keys: Array<{ name: string }> }>;
}

export interface SendEmailPayload {
  from: string | { email: string; name?: string };
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
}

export interface SendEmailBinding {
  send(message: SendEmailPayload): Promise<unknown>;
}

export interface MagicLinkEnv {
  /** Workers KV namespace storing single-use magic-link nonces & rate limits */
  DIALTONE_AUTH_TOKENS?: KvNamespaceBinding;
  /** Cloudflare native send_email binding */
  SEND_EMAIL?: SendEmailBinding;
  /** 256-bit secret used for HMAC-SHA256 magic tokens and session cookies */
  SESSION_SIGNING_KEY?: string;
  /** JSON map of exact hostname -> array of authorized lowercase emails */
  MAGIC_LINK_ALLOWLIST?: string;
  /** Optional JSON map of login email -> verified destination email for delivery */
  MAGIC_LINK_DELIVERY_MAP?: string;
  /** Optional sender address, e.g. "login@dialtone.earth" */
  MAGIC_LINK_FROM?: string;
}

export interface MagicLinkDeps {
  sendEmail?: (payload: SendEmailPayload) => Promise<unknown>;
  nowSec?: () => number;
}

export interface SessionCheckResult {
  valid: boolean;
  subject?: string;
  sessionId?: string;
  reason?: string;
}

export const SESSION_COOKIE_NAME = "dialtone_session";
const MAGIC_TOKEN_TTL_SEC = 600; // 10 minutes
const SESSION_TTL_SEC = 86_400; // 24 hours
const RATE_LIMIT_WINDOW_SEC = 600;
const RATE_LIMIT_MAX_SENDS = 5;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface MagicTokenPayload {
  typ: "magic";
  sub: string;
  host: string;
  jti: string;
  iat: number;
  exp: number;
}

interface SessionTokenPayload {
  typ: "session";
  sub: string;
  host: string;
  sid?: string;
  iat: number;
  exp: number;
}

export function parseAllowlistMap(
  raw: string | undefined,
): Record<string, string[]> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string[]> = {};
    for (const [host, value] of Object.entries(parsed)) {
      const normalizedHost = host.trim().toLowerCase();
      if (!normalizedHost) continue;
      const items = Array.isArray(value)
        ? value
        : typeof value === "string"
          ? [value]
          : [];
      const emails = items
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().toLowerCase())
        .filter((item) => EMAIL_RE.test(item));
      if (emails.length > 0) {
        out[normalizedHost] = Array.from(new Set(emails));
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function parseDeliveryMap(
  raw: string | undefined,
): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const fromKey = k.trim().toLowerCase();
      if (typeof v !== "string") continue;
      const toAddr = v.trim().toLowerCase();
      if (EMAIL_RE.test(fromKey) && EMAIL_RE.test(toAddr)) {
        out[fromKey] = toAddr;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function isMagicLinkEnabledForHost(
  env: MagicLinkEnv,
  host: string,
): boolean {
  const key = (env.SESSION_SIGNING_KEY ?? "").trim();
  if (key.length < 16) return false;
  const allowlist = parseAllowlistMap(env.MAGIC_LINK_ALLOWLIST);
  return (allowlist[host.toLowerCase()]?.length ?? 0) > 0;
}

export async function verifySessionCookie(
  request: Request,
  env: MagicLinkEnv,
  host: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<SessionCheckResult> {
  const secret = (env.SESSION_SIGNING_KEY ?? "").trim();
  if (secret.length < 16) {
    return { valid: false, reason: "session_not_configured" };
  }
  const token = extractCookie(request, SESSION_COOKIE_NAME);
  if (!token) {
    return { valid: false, reason: "no_session_cookie" };
  }

  const verified = await verifySignedToken<SessionTokenPayload>(
    token,
    secret,
    "session-v1",
  );
  if (!verified.valid || !verified.payload) {
    return { valid: false, reason: verified.reason ?? "invalid_session" };
  }

  const payload = verified.payload;
  if (payload.typ !== "session") {
    return { valid: false, reason: "wrong_token_type" };
  }
  if (typeof payload.exp !== "number" || payload.exp <= nowSec) {
    return { valid: false, reason: "session_expired" };
  }
  if (payload.host !== host.toLowerCase()) {
    return { valid: false, reason: "wrong_host" };
  }

  const allowlist = parseAllowlistMap(env.MAGIC_LINK_ALLOWLIST);
  const allowed = allowlist[host.toLowerCase()] ?? [];
  if (!allowed.includes(payload.sub.toLowerCase())) {
    return { valid: false, reason: "subject_not_allowlisted" };
  }

  const sessionId =
    typeof payload.sid === "string" && /^[a-f0-9]{8,64}$/.test(payload.sid)
      ? payload.sid
      : `legacy-${payload.iat}`;

  return { valid: true, subject: payload.sub.toLowerCase(), sessionId };
}

export async function handleAuthRoute(
  request: Request,
  env: MagicLinkEnv,
  securityHeaders: Record<string, string>,
  deps: MagicLinkDeps = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  const pathname = url.pathname;
  const nowSec = deps.nowSec ? deps.nowSec() : Math.floor(Date.now() / 1000);
  const isSecure =
    url.protocol === "https:" ||
    (host !== "127.0.0.1" && host !== "localhost");

  if (pathname === "/login") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed(securityHeaders);
    }
    const existing = await verifySessionCookie(request, env, host, nowSec);
    if (existing.valid) {
      return redirectResponse("/", securityHeaders);
    }
    const sent = url.searchParams.get("sent") === "1";
    const err = url.searchParams.get("error") ?? "";
    return htmlResponse(
      renderLoginPage({
        host,
        sent,
        errorCode: err,
        enabled: isMagicLinkEnabledForHost(env, host),
      }),
      200,
      securityHeaders,
    );
  }

  if (pathname === "/api/auth/request-link") {
    if (request.method !== "POST") {
      return methodNotAllowed(securityHeaders);
    }
    return handleRequestMagicLink(
      request,
      url,
      host,
      env,
      securityHeaders,
      deps,
      nowSec,
    );
  }

  if (pathname === "/auth/auto-verify.js") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed(securityHeaders);
    }
    const js = `document.addEventListener("DOMContentLoaded",function(){var f=document.querySelector('form[data-auto-submit="1"]');if(f)f.submit();});\n`;
    return new Response(js, {
      status: 200,
      headers: {
        ...securityHeaders,
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "private, no-store",
      },
    });
  }

  if (pathname === "/auth/verify") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed(securityHeaders);
    }
    const token = (url.searchParams.get("token") ?? "").trim();
    const check = await validateMagicToken(token, env, host, nowSec, false);
    if (!check.valid || !check.payload) {
      return htmlResponse(
        renderVerifyPage({ host, valid: false }),
        400,
        securityHeaders,
      );
    }
    return htmlResponse(
      renderVerifyPage({
        host,
        valid: true,
        email: check.payload.sub,
        token,
      }),
      200,
      securityHeaders,
    );
  }

  if (pathname === "/api/auth/verify") {
    if (request.method !== "POST") {
      return methodNotAllowed(securityHeaders);
    }
    const body = await readFormOrJson(request);
    const token = (body.token ?? "").trim();
    const check = await validateMagicToken(token, env, host, nowSec, true);
    const wantsJson = prefersJson(request);
    if (!check.valid || !check.payload) {
      if (wantsJson) {
        return jsonAuthResponse(
          { error: "Sign-in link is invalid or expired" },
          401,
          securityHeaders,
        );
      }
      return redirectResponse("/login?error=invalid", securityHeaders);
    }

    const secret = (env.SESSION_SIGNING_KEY ?? "").trim();
    const sessionPayload: SessionTokenPayload = {
      typ: "session",
      sub: check.payload.sub,
      host,
      sid: randomHex(12),
      iat: nowSec,
      exp: nowSec + SESSION_TTL_SEC,
    };
    const sessionToken = await signToken(sessionPayload, secret, "session-v1");
    const cookie = buildSessionCookie(sessionToken, SESSION_TTL_SEC, isSecure);

    if (wantsJson) {
      const resp = jsonAuthResponse(
        {
          authenticated: true,
          subject: check.payload.sub,
          hostname: host,
        },
        200,
        securityHeaders,
      );
      resp.headers.append("Set-Cookie", cookie);
      return resp;
    }

    return redirectResponse("/", securityHeaders, cookie);
  }

  if (pathname === "/auth/logout" || pathname === "/api/auth/logout") {
    if (
      pathname === "/api/auth/logout" &&
      request.method !== "POST"
    ) {
      return methodNotAllowed(securityHeaders);
    }
    if (
      pathname === "/auth/logout" &&
      request.method !== "GET" &&
      request.method !== "POST"
    ) {
      return methodNotAllowed(securityHeaders);
    }
    const existing = await verifySessionCookie(request, env, host, nowSec);
    if (existing.valid && existing.sessionId) {
      await clearUserPresence(env.DIALTONE_AUTH_TOKENS, host, existing.sessionId);
    }
    const clearCookie = buildSessionCookie("", 0, isSecure);
    if (prefersJson(request)) {
      const resp = jsonAuthResponse({ ok: true }, 200, securityHeaders);
      resp.headers.append("Set-Cookie", clearCookie);
      return resp;
    }
    return redirectResponse("/", securityHeaders, clearCookie);
  }

  return null;
}

async function handleRequestMagicLink(
  request: Request,
  url: URL,
  host: string,
  env: MagicLinkEnv,
  securityHeaders: Record<string, string>,
  deps: MagicLinkDeps,
  nowSec: number,
): Promise<Response> {
  const wantsJson = prefersJson(request);
  const body = await readFormOrJson(request);
  const email = (body.email ?? "").trim().toLowerCase();

  if (!EMAIL_RE.test(email)) {
    if (wantsJson) {
      return jsonAuthResponse(
        { error: "Please enter a valid email address." },
        400,
        securityHeaders,
      );
    }
    return redirectResponse("/login?error=email", securityHeaders);
  }

  const secret = (env.SESSION_SIGNING_KEY ?? "").trim();
  const allowlist = parseAllowlistMap(env.MAGIC_LINK_ALLOWLIST);
  const allowedEmails = allowlist[host] ?? [];
  const isAuthorized = secret.length >= 16 && allowedEmails.includes(email);

  if (isAuthorized) {
    const rateLimited = await checkAndIncrementRateLimit(
      env.DIALTONE_AUTH_TOKENS,
      host,
      email,
    );
    if (!rateLimited) {
      const jti = randomHex(16);
      const payload: MagicTokenPayload = {
        typ: "magic",
        sub: email,
        host,
        jti,
        iat: nowSec,
        exp: nowSec + MAGIC_TOKEN_TTL_SEC,
      };
      const token = await signToken(payload, secret, "magic-v1");

      if (env.DIALTONE_AUTH_TOKENS) {
        await env.DIALTONE_AUTH_TOKENS.put(
          `magic:${jti}`,
          JSON.stringify({ sub: email, host }),
          { expirationTtl: MAGIC_TOKEN_TTL_SEC },
        );
      }

      const verifyUrl = `${url.origin}/auth/verify?token=${encodeURIComponent(token)}`;
      const fromEmail =
        (env.MAGIC_LINK_FROM ?? "").trim() || "login@dialtone.earth";
      const deliveryMap = parseDeliveryMap(env.MAGIC_LINK_DELIVERY_MAP);
      const deliveryTo = deliveryMap[email] ?? email;
      const isAliased = deliveryTo !== email;
      const message: SendEmailPayload = {
        from: { email: fromEmail, name: "dialtone.earth" },
        to: deliveryTo,
        subject: isAliased
          ? `Sign in to ${host} (${email})`
          : `Sign in to ${host}`,
        text: [
          `Sign in to dialtone.earth (${host}) as ${email}`,
          "",
          "Open this single-use link to sign in (valid for 10 minutes):",
          verifyUrl,
          "",
          "If you did not request this sign-in link, you can safely ignore this email.",
        ].join("\n"),
        html: renderMagicLinkEmailHtml(host, email, verifyUrl),
      };

      try {
        if (deps.sendEmail) {
          await deps.sendEmail(message);
        } else if (env.SEND_EMAIL) {
          await env.SEND_EMAIL.send(message);
        } else {
          console.error("[auth] SEND_EMAIL binding is not configured");
        }
      } catch (err) {
        console.error(
          "[auth] failed to send magic link email:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  // Always return a uniform response so account membership cannot be enumerated.
  if (wantsJson) {
    return jsonAuthResponse(
      {
        ok: true,
        message: "If that email is authorized, a sign-in link has been sent.",
      },
      200,
      securityHeaders,
    );
  }
  return redirectResponse("/login?sent=1", securityHeaders);
}

async function validateMagicToken(
  token: string,
  env: MagicLinkEnv,
  host: string,
  nowSec: number,
  consume: boolean,
): Promise<{ valid: boolean; payload?: MagicTokenPayload; reason?: string }> {
  const secret = (env.SESSION_SIGNING_KEY ?? "").trim();
  if (!token || secret.length < 16) {
    return { valid: false, reason: "missing_token_or_key" };
  }

  const verified = await verifySignedToken<MagicTokenPayload>(
    token,
    secret,
    "magic-v1",
  );
  if (!verified.valid || !verified.payload) {
    return { valid: false, reason: verified.reason ?? "bad_signature" };
  }

  const payload = verified.payload;
  if (payload.typ !== "magic") {
    return { valid: false, reason: "wrong_token_type" };
  }
  if (typeof payload.exp !== "number" || payload.exp <= nowSec) {
    return { valid: false, reason: "expired" };
  }
  if (payload.host !== host.toLowerCase()) {
    return { valid: false, reason: "wrong_host" };
  }
  if (!payload.jti || !/^[a-f0-9]{16,64}$/.test(payload.jti)) {
    return { valid: false, reason: "invalid_jti" };
  }

  const allowlist = parseAllowlistMap(env.MAGIC_LINK_ALLOWLIST);
  const allowed = allowlist[host.toLowerCase()] ?? [];
  if (!allowed.includes(payload.sub.toLowerCase())) {
    return { valid: false, reason: "subject_not_allowlisted" };
  }

  if (env.DIALTONE_AUTH_TOKENS) {
    const kvKey = `magic:${payload.jti}`;
    const stored = await env.DIALTONE_AUTH_TOKENS.get(kvKey);
    if (!stored) {
      return { valid: false, reason: "already_used_or_expired" };
    }
    try {
      const parsed = JSON.parse(stored) as { sub?: string; host?: string };
      if (
        parsed.sub !== payload.sub.toLowerCase() ||
        parsed.host !== host.toLowerCase()
      ) {
        return { valid: false, reason: "nonce_mismatch" };
      }
    } catch {
      return { valid: false, reason: "corrupt_nonce" };
    }
    if (consume) {
      await env.DIALTONE_AUTH_TOKENS.delete(kvKey);
    }
  }

  return { valid: true, payload };
}

async function checkAndIncrementRateLimit(
  kv: KvNamespaceBinding | undefined,
  host: string,
  email: string,
): Promise<boolean> {
  if (!kv) return false;
  const key = `rl:${host}:${email}`;
  const raw = await kv.get(key);
  const count = raw ? Number.parseInt(raw, 10) : 0;
  if (Number.isFinite(count) && count >= RATE_LIMIT_MAX_SENDS) {
    return true;
  }
  const next = Number.isFinite(count) && count > 0 ? count + 1 : 1;
  await kv.put(key, String(next), { expirationTtl: RATE_LIMIT_WINDOW_SEC });
  return false;
}

async function signToken(
  payload: object,
  secret: string,
  domain: string,
): Promise<string> {
  const payloadB64 = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const key = await importHmacKey(secret, domain, ["sign"]);
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${domain}.${payloadB64}`),
  );
  const sigB64 = encodeBase64Url(new Uint8Array(sigBuf));
  return `${payloadB64}.${sigB64}`;
}

async function verifySignedToken<T>(
  token: string,
  secret: string,
  domain: string,
): Promise<{ valid: boolean; payload?: T; reason?: string }> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { valid: false, reason: "malformed_token" };
  }
  try {
    const key = await importHmacKey(secret, domain, ["verify"]);
    const signature = decodeBase64Url(parts[1]);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      new TextEncoder().encode(`${domain}.${parts[0]}`),
    );
    if (!ok) {
      return { valid: false, reason: "bad_signature" };
    }
    const decoded = new TextDecoder().decode(decodeBase64Url(parts[0]));
    const payload = JSON.parse(decoded) as T;
    return { valid: true, payload };
  } catch {
    return { valid: false, reason: "verification_error" };
  }
}

async function importHmacKey(
  secret: string,
  domain: string,
  usages: Array<"sign" | "verify">,
): Promise<CryptoKey> {
  const material = new TextEncoder().encode(`${domain}:${secret}`);
  const derived = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey(
    "raw",
    derived,
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

function renderLoginPage(opts: {
  host: string;
  sent: boolean;
  errorCode: string;
  enabled: boolean;
}): string {
  const isStaging = opts.host.toLowerCase() === "test.dialtone.earth";
  let statusBanner = "";
  if (opts.sent) {
    statusBanner = `<p class="notice is-ok" role="status">Check your email for a sign-in link.</p>`;
  } else if (opts.errorCode === "invalid" || opts.errorCode === "expired") {
    statusBanner = `<p class="notice is-err" role="alert">That sign-in link has expired or was already used. Request a new one.</p>`;
  } else if (opts.errorCode === "email") {
    statusBanner = `<p class="notice is-err" role="alert">Enter a valid email address.</p>`;
  } else if (!opts.enabled) {
    statusBanner = `<p class="notice" role="status">Sign-in is not enabled on this hostname.</p>`;
  }

  return renderAuthShell({
    title: `DIALTONE // EARTH — ${opts.host}`,
    host: opts.host,
    badge: isStaging ? "STAGING AUTH" : "MESH AUTH",
    caption: isStaging
      ? "Owner magic-link sign-in for live test dashboard & deploy."
      : "Single-use passwordless email link for private mesh access.",
    backHref: isStaging ? "https://dialtone.earth/" : "/",
    backLabel: isStaging ? "dialtone.earth" : "overview",
    bodyHtml: `
      <div class="card-head">
        <span class="card-kicker">${isStaging ? "OWNER SIGN IN" : "SIGN IN"}</span>
        <span class="card-host">${escapeHtml(opts.host)}</span>
      </div>
      ${statusBanner}
      <form method="POST" action="/api/auth/request-link" class="auth-form">
        <label class="sr-only" for="email">Email address</label>
        <input
          id="email"
          name="email"
          type="email"
          inputmode="email"
          autocomplete="email"
          placeholder="Email address"
          required
          autofocus
        />
        <button type="submit">Send sign-in link</button>
      </form>
    `,
  });
}

function renderVerifyPage(opts: {
  host: string;
  valid: boolean;
  email?: string;
  token?: string;
}): string {
  const isStaging = opts.host.toLowerCase() === "test.dialtone.earth";
  if (!opts.valid || !opts.token) {
    return renderAuthShell({
      title: `DIALTONE // EARTH — ${opts.host}`,
      host: opts.host,
      badge: "LINK EXPIRED",
      caption: "Magic links expire after 10 minutes or a single sign-in.",
      backHref: "/login",
      backLabel: "sign in",
      bodyHtml: `
        <div class="card-head">
          <span class="card-kicker">VERIFY LINK</span>
          <span class="card-host">${escapeHtml(opts.host)}</span>
        </div>
        <p class="notice is-err" role="alert">This sign-in link has expired or was already used.</p>
        <a class="btn-link" href="/login">Request a new link</a>
      `,
    });
  }

  const autoSubmit = isStaging;
  return renderAuthShell({
    title: `DIALTONE // EARTH — ${opts.host}`,
    host: opts.host,
    badge: isStaging ? "STAGING VERIFY" : "MESH VERIFY",
    caption: autoSubmit
      ? `Completing single-use magic-link session for ${opts.host}.`
      : `Confirm single-use sign-in to ${opts.host}.`,
    backHref: "/login",
    backLabel: "sign in",
    bodyHtml: `
      <div class="card-head">
        <span class="card-kicker">VERIFY SESSION</span>
        <span class="card-host">${escapeHtml(opts.host)}</span>
      </div>
      <p class="identity">${escapeHtml(opts.email ?? "")}</p>
      <form method="POST" action="/api/auth/verify" class="auth-form"${autoSubmit ? ' data-auto-submit="1"' : ""}>
        <input type="hidden" name="token" value="${escapeHtml(opts.token)}" />
        <button type="submit">${autoSubmit ? `Signing in to ${escapeHtml(opts.host)}…` : `Continue to ${escapeHtml(opts.host)}`}</button>
      </form>${autoSubmit ? '\n      <script src="/auth/auto-verify.js" defer></script>' : ""}
    `,
  });
}

function renderAuthShell(opts: {
  title: string;
  host: string;
  badge: string;
  caption: string;
  backHref: string;
  backLabel: string;
  bodyHtml: string;
}): string {
  return `<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="dark" />
    <meta name="theme-color" content="#000000" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <title>${escapeHtml(opts.title)}</title>
    <style>
      *, *::before, *::after { box-sizing: border-box; }
      :root {
        --bg: #000000;
        --panel: rgba(10, 10, 10, 0.80);
        --line: #262626;
        --line-hi: #484848;
        --ink: #f0f0f0;
        --muted: #8a8a8a;
        --ok: #36d66b;
        --warn: #e0b44a;
        --err: #ff6b6b;
        --btn-bg: #f0f0f0;
        --btn-bg-hover: #ffffff;
        --btn-ink: #000000;
      }
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: var(--bg);
        color: var(--ink);
        font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
        -webkit-font-smoothing: antialiased;
      }
      #auth-globe-stage {
        position: fixed;
        inset: 0;
        z-index: 0;
        width: 100%;
        height: 100%;
        background: #000000;
      }
      #auth-globe-stage canvas {
        display: block;
        width: 100% !important;
        height: 100% !important;
      }
      .globe-meta-overlay {
        position: fixed;
        top: 10px;
        right: 12px;
        z-index: 5;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 3px;
        text-align: right;
        pointer-events: none;
      }
      .globe-meta-brand-row {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        background: rgba(10, 10, 10, 0.78);
        padding: 3px 8px;
      }
      .tbl-brand {
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.08em;
        color: var(--ink);
      }
      .auth-pill {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.06em;
        color: var(--ok);
        border: 1px solid rgba(54, 214, 107, 0.55);
        padding: 1px 6px;
        background: rgba(10, 10, 10, 0.85);
      }
      .globe-meta-line {
        font-size: 11px;
        color: var(--muted);
        background: rgba(10, 10, 10, 0.78);
        padding: 1px 8px;
        line-height: 1.35;
      }
      .globe-meta-line.is-ch {
        color: var(--ok);
        font-weight: 700;
      }
      .auth-center {
        position: fixed;
        inset: 0;
        z-index: 4;
        display: grid;
        place-items: center;
        padding: 84px 16px 64px;
        pointer-events: none;
      }
      main {
        width: 100%;
        max-width: 368px;
        background: var(--panel);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        border: 1px solid var(--line-hi);
        padding: 20px;
        pointer-events: auto;
      }
      .card-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 10px;
        padding-bottom: 12px;
        margin-bottom: 16px;
        border-bottom: 1px solid var(--line);
      }
      .card-kicker {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        color: var(--ink);
      }
      .card-host {
        font-size: 11px;
        color: var(--muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .notice {
        margin: 0 0 14px;
        padding: 9px 11px;
        border: 1px solid var(--line-hi);
        background: rgba(18, 18, 18, 0.92);
        color: var(--ink);
        font-size: 12px;
        line-height: 1.45;
      }
      .notice.is-ok {
        border-color: rgba(54, 214, 107, 0.6);
        color: var(--ok);
      }
      .notice.is-err {
        border-color: rgba(255, 107, 107, 0.65);
        color: var(--err);
      }
      .identity {
        margin: 0 0 14px;
        padding: 8px 10px;
        border: 1px solid var(--line);
        background: rgba(0, 0, 0, 0.65);
        color: var(--ink);
        font-size: 12px;
        word-break: break-all;
      }
      .auth-form {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
      input[type="email"] {
        width: 100%;
        height: 40px;
        padding: 0 12px;
        border: 1px solid var(--line-hi);
        background: rgba(0, 0, 0, 0.88);
        color: var(--ink);
        font: inherit;
        font-size: 13px;
        outline: none;
        transition: border-color 120ms ease;
      }
      input[type="email"]::placeholder {
        color: #6b6b6b;
      }
      input[type="email"]:focus {
        border-color: #ffffff;
      }
      button, .btn-link {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 40px;
        padding: 0 14px;
        border: 1px solid var(--btn-bg);
        background: var(--btn-bg);
        color: var(--btn-ink);
        font: inherit;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        text-decoration: none;
        cursor: pointer;
        transition: background-color 120ms ease, border-color 120ms ease;
      }
      button:hover, .btn-link:hover {
        background: var(--btn-bg-hover);
        border-color: var(--btn-bg-hover);
      }
      button:focus-visible, .btn-link:focus-visible {
        outline: 2px solid #ffffff;
        outline-offset: 2px;
      }
      .auth-bottom-bar {
        position: fixed;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 6;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 8px 12px;
        background: rgba(8, 8, 8, 0.92);
        border-top: 1px solid var(--line);
        font-size: 11px;
      }
      .bottom-cc {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: baseline;
        gap: 8px;
      }
      .bottom-cc-kicker {
        flex-shrink: 0;
        font-weight: 700;
        color: var(--warn);
      }
      .bottom-cc-text {
        color: var(--muted);
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        line-height: 1.35;
      }
      .bottom-chip {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        padding: 5px 10px;
        border: 1px solid var(--line-hi);
        background: #0d0d0d;
        color: var(--ink);
        text-decoration: none;
        font-size: 11px;
        letter-spacing: 0.03em;
      }
      .bottom-chip:hover {
        border-color: #ffffff;
        background: #181818;
      }
      @media (max-width: 899px) {
        .globe-meta-overlay {
          top: 6px;
          right: 8px;
          gap: 2px;
        }
        .tbl-brand { font-size: 12px; }
        .globe-meta-line { font-size: 10px; padding: 1px 5px; }
        .auth-center { padding: 72px 12px 62px; }
        main { padding: 16px; }
        .auth-bottom-bar { padding: 6px 8px; gap: 8px; }
        .bottom-cc-text { font-size: 10px; }
      }
    </style>
  </head>
  <body>
    <div id="auth-globe-stage" aria-hidden="true"></div>
    <div class="globe-meta-overlay">
      <div class="globe-meta-brand-row">
        <span class="tbl-brand">DIALTONE // EARTH</span>
        <span class="auth-pill">${escapeHtml(opts.badge)}</span>
      </div>
      <div class="globe-meta-line is-ch">H3: GEOSPATIAL MESH · MAGIC LINK</div>
      <div class="globe-meta-line">${escapeHtml(opts.host)}</div>
    </div>
    <div class="auth-center">
      <main>${opts.bodyHtml}</main>
    </div>
    <footer class="auth-bottom-bar">
      <div class="bottom-cc">
        <span class="bottom-cc-kicker">CC AUTH</span>
        <span class="bottom-cc-text">${escapeHtml(opts.caption)}</span>
      </div>
      <a class="bottom-chip" href="${escapeHtml(opts.backHref)}">${escapeHtml(opts.backLabel)}</a>
    </footer>
    <script type="module" src="/auth-globe.js"></script>
  </body>
</html>`;
}

function renderMagicLinkEmailHtml(
  host: string,
  email: string,
  verifyUrl: string,
): string {
  const safeHost = escapeHtml(host);
  const safeEmail = escapeHtml(email);
  const safeUrl = escapeHtml(verifyUrl);
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:32px 16px;background:#0d0d0d;color:#ececec;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:440px;margin:0 auto;background:#151515;border:1px solid #2a2a2a;border-radius:10px;">
      <tr>
        <td style="padding:28px 24px;">
          <div style="font-size:16px;font-weight:600;letter-spacing:0.04em;color:#ececec;margin-bottom:4px;">dialtone.earth</div>
          <div style="font-size:12px;color:#8c8c8c;margin-bottom:18px;">${safeHost} · ${safeEmail}</div>
          <a href="${safeUrl}" style="display:inline-block;padding:12px 20px;background:#e6e6e6;color:#0d0d0d;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">Sign in to ${safeHost}</a>
          <p style="margin:20px 0 8px;font-size:12px;line-height:1.5;color:#8c8c8c;">This single-use link expires in 10 minutes. If you did not request it, you can ignore this email.</p>
          <p style="margin:0;font-size:11px;line-height:1.4;color:#666666;word-break:break-all;">${safeUrl}</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function readFormOrJson(
  request: Request,
): Promise<Record<string, string>> {
  const contentType = (request.headers.get("Content-Type") ?? "").toLowerCase();
  if (contentType.includes("application/json")) {
    try {
      const parsed: unknown = await request.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "string") out[k] = v;
        }
        return out;
      }
    } catch {
      return {};
    }
    return {};
  }
  try {
    const text = await request.text();
    const params = new URLSearchParams(text);
    const out: Record<string, string> = {};
    for (const [k, v] of params.entries()) {
      out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function prefersJson(request: Request): boolean {
  const accept = (request.headers.get("Accept") ?? "").toLowerCase();
  const contentType = (request.headers.get("Content-Type") ?? "").toLowerCase();
  return (
    accept.includes("application/json") ||
    contentType.includes("application/json")
  );
}

function buildSessionCookie(
  value: string,
  maxAgeSec: number,
  isSecure: boolean,
): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  if (isSecure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function extractCookie(request: Request, name: string): string {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) {
      return rest.join("=").trim();
    }
  }
  return "";
}

function htmlResponse(
  html: string,
  status: number,
  securityHeaders: Record<string, string>,
): Response {
  const headers = new Headers(securityHeaders);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "private, no-store");
  return new Response(html, { status, headers });
}

function jsonAuthResponse(
  payload: unknown,
  status: number,
  securityHeaders: Record<string, string>,
): Response {
  const headers = new Headers(securityHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "private, no-store");
  return new Response(JSON.stringify(payload), { status, headers });
}

function redirectResponse(
  location: string,
  securityHeaders: Record<string, string>,
  setCookie?: string,
): Response {
  const headers = new Headers(securityHeaders);
  headers.set("Location", location);
  headers.set("Cache-Control", "private, no-store");
  if (setCookie) {
    headers.append("Set-Cookie", setCookie);
  }
  return new Response(null, { status: 303, headers });
}

function methodNotAllowed(securityHeaders: Record<string, string>): Response {
  return jsonAuthResponse({ error: "Method not allowed" }, 405, securityHeaders);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeBase64Url(input: string): Uint8Array<ArrayBuffer> {
  const padded =
    input.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((input.length + 3) % 4);
  const binary = atob(padded);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
