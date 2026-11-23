import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  handleGatewayRequest,
  SECURITY_HEADERS,
} from "../worker/gateway.ts";

const registryDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const distDir = path.join(registryDir, "dist");
const port = Number(process.env.GATEWAY_PORT || 5176);
const meshOrigin = process.env.DIALTONE_ORIGIN || "http://127.0.0.1:8788";
const testOrigin = process.env.TEST_DASHBOARD_ORIGIN || "http://127.0.0.1:5174";
const teamDomain = `http://127.0.0.1:${port}`;
const audience = "aud-metal-local-gateway";

// Ephemeral RS256 keypair verifying real Cloudflare Access JWT validation end-to-end.
const keyPair = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
const kid = "local-access-kid-1";

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function mintAccessJwt(email) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", kid }));
  const payload = b64url(
    JSON.stringify({
      iss: teamDomain,
      aud: [audience],
      exp: now + 3600,
      nbf: now - 5,
      email,
    }),
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64url(sig)}`;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

async function serveStatic(request) {
  const url = new URL(request.url);
  let rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const target = path.resolve(distDir, "." + rel);
  if (!target.startsWith(distDir)) {
    return new Response("Forbidden", { status: 403 });
  }
  try {
    const data = await readFile(target);
    const ext = path.extname(target).toLowerCase();
    return new Response(data, {
      status: 200,
      headers: {
        ...SECURITY_HEADERS,
        "Content-Type": MIME[ext] || "application/octet-stream",
      },
    });
  } catch {
    const notFound = await readFile(path.join(distDir, "404.html"));
    return new Response(notFound, {
      status: 404,
      headers: { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

const env = {
  ASSETS: { fetch: serveStatic },
  ACCESS_TEAM_DOMAIN: teamDomain,
  ACCESS_AUD_MAP: JSON.stringify({
    "127.0.0.1": audience,
    localhost: audience,
  }),
  MESH_ORIGINS_MAP: JSON.stringify({
    "127.0.0.1": [meshOrigin],
    localhost: [meshOrigin],
  }),
  TEST_DASHBOARD_ORIGIN: testOrigin,
  ACCESS_LOGIN_URL: "/cdn-cgi/access/login",
  ACCESS_LOGOUT_URL: "/cdn-cgi/access/logout",
};

const loginHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Cloudflare Access — Sign in to dialtone.earth</title>
  <style>
    :root { color: #ececec; background: #0d0d0d; font-family: ui-monospace, Consolas, monospace; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
    form { width: min(400px, calc(100vw - 32px)); padding: 24px; border: 1px solid #2e2e2e; border-radius: 10px; background: #141414; }
    h1 { margin: 0 0 8px; font-size: 1rem; letter-spacing: 0.06em; }
    p { margin: 0 0 16px; color: #9c9c9c; font-size: 0.82rem; line-height: 1.5; }
    label { display: block; margin-bottom: 6px; font-size: 0.78rem; color: #bdbdbd; }
    input { width: 100%; box-sizing: border-box; padding: 10px 12px; margin-bottom: 14px; border: 1px solid #3a3a3a; border-radius: 6px; background: #0b0d10; color: #fff; font: inherit; }
    button { width: 100%; padding: 10px 14px; border: 0; border-radius: 6px; background: #ececec; color: #111; font: inherit; font-weight: 700; cursor: pointer; }
  </style>
</head>
<body>
  <form method="POST" action="/cdn-cgi/access/login">
    <h1>CLOUDFLARE ACCESS // METAL.DIALTONE.EARTH</h1>
    <p>Sign in to mint an RS256 Cloudflare Access JWT session for the live local Dialtone v0.5.5 metal mesh gateway.</p>
    <label for="email">Authorized Operator Email</label>
    <input id="email" name="email" type="email" value="timcash@gmail.com" required />
    <button type="submit" data-testid="access-submit">Sign in to metal mesh</button>
  </form>
</body>
</html>`;

const server = createServer(async (req, res) => {
  try {
    const fullUrl = `http://127.0.0.1:${port}${req.url || "/"}`;
    const parsed = new URL(fullUrl);

    if (parsed.pathname === "/cdn-cgi/access/certs" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ keys: [{ ...publicJwk, kid }] }));
      return;
    }

    if (parsed.pathname === "/cdn-cgi/access/login" && req.method === "GET") {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
      });
      res.end(loginHtml);
      return;
    }

    if (parsed.pathname === "/cdn-cgi/access/login" && req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bodyStr = Buffer.concat(chunks).toString("utf8");
      const params = new URLSearchParams(bodyStr);
      const email = (params.get("email") || "").trim();
      if (!email || !email.includes("@")) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Valid email required");
        return;
      }
      const jwt = await mintAccessJwt(email);
      res.writeHead(302, {
        ...SECURITY_HEADERS,
        "Cache-Control": "private, no-store",
        "Set-Cookie": `CF_Authorization=${jwt}; Path=/; HttpOnly; SameSite=Lax`,
        Location: "/",
      });
      res.end();
      return;
    }

    if (parsed.pathname === "/cdn-cgi/access/logout") {
      res.writeHead(302, {
        ...SECURITY_HEADERS,
        "Cache-Control": "private, no-store",
        "Set-Cookie": "CF_Authorization=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
        Location: "/",
      });
      res.end();
      return;
    }

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v.join(", "));
    }
    const request = new Request(fullUrl, { method: req.method, headers });
    const response = await handleGatewayRequest(request, env);
    const outHeaders = {};
    response.headers.forEach((v, k) => {
      outHeaders[k] = v;
    });
    res.writeHead(response.status, outHeaders);
    const buf = Buffer.from(await response.arrayBuffer());
    res.end(buf);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(err) }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`dialtone-earth local live gateway listening on http://127.0.0.1:${port}/`);
  console.log(`  mesh origin: ${meshOrigin}`);
  console.log(`  test origin: ${testOrigin}`);
});
