import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

const ALLOWED_MESH_ROUTES = new Set([
  "/api/mesh",
  "/api/state",
  "/api/details",
  "/api/plugins",
  "/api/shell/sessions",
  "/api/processes",
  "/api/probe",
  "/api/net",
  "/api/links",
]);

const TEST_RUN_RE = /^\/api\/test-runs\/([a-f0-9]{32})(\/log)?$/;

export function constantTimeTokenMatch(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function sanitizeStatePayload(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return {
    node: raw.node ?? "",
    events: Array.isArray(raw.events) ? raw.events.slice(-25) : [],
    alerts: Array.isArray(raw.alerts) ? raw.alerts.slice(-25) : [],
    blob_fetches: Array.isArray(raw.blob_fetches) ? raw.blob_fetches.slice(-25) : [],
    probe: raw.probe ?? null,
    processes: Array.isArray(raw.processes) ? raw.processes : [],
    stats: raw.stats ?? null,
  };
}

export function createOriginBridgeHandler({
  token,
  meshOrigin = "http://127.0.0.1:8788",
  testOrigin = "http://127.0.0.1:5174",
  fetchImpl = fetch,
}) {
  if (!token || token.length < 16) {
    throw new Error("MESH_ORIGIN_TOKEN (>= 16 chars) is required");
  }

  return async function handle(req, res) {
    const sendJson = (status, payload) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(payload));
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(405, { error: "Method not allowed; origin bridge is read-only" });
      return;
    }

    const authHeader = String(req.headers.authorization || "");
    const bearer = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";
    if (!constantTimeTokenMatch(bearer, token)) {
      sendJson(401, { error: "Unauthorized" });
      return;
    }

    const url = new URL(req.url || "/", "http://127.0.0.1");
    let upstreamBase = null;
    let upstreamPath = url.pathname;

    if (ALLOWED_MESH_ROUTES.has(url.pathname)) {
      upstreamBase = meshOrigin;
      if (url.pathname === "/api/details") {
        const nodeId = url.searchParams.get("node_id") || "";
        if (/^[a-zA-Z0-9_-]{1,128}$/.test(nodeId)) {
          upstreamPath = `/api/details?node_id=${encodeURIComponent(nodeId)}`;
        }
      }
    } else if (url.pathname === "/api/tests" || TEST_RUN_RE.test(url.pathname)) {
      upstreamBase = testOrigin;
    } else {
      sendJson(404, { error: "Route not allowlisted" });
      return;
    }

    try {
      const target = new URL(upstreamPath, upstreamBase).toString();
      const upstream = await fetchImpl(target, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      });
      if (url.pathname === "/api/state" && upstream.ok) {
        const parsed = await upstream.json();
        sendJson(200, sanitizeStatePayload(parsed));
        return;
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, {
        "Content-Type":
          upstream.headers.get("Content-Type") ||
          "application/json; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(buf);
    } catch {
      sendJson(502, { error: "Local Dialtone upstream unavailable" });
    }
  };
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());

if (isDirectRun) {
  const token = (process.env.MESH_ORIGIN_TOKEN || "").trim();
  const port = Number(process.env.ORIGIN_BRIDGE_PORT || 8790);
  const meshOrigin = process.env.DIALTONE_ORIGIN || "http://127.0.0.1:8788";
  const testOrigin = process.env.TEST_DASHBOARD_ORIGIN || "http://127.0.0.1:5174";
  const handler = createOriginBridgeHandler({ token, meshOrigin, testOrigin });
  createServer(handler).listen(port, "127.0.0.1", () => {
    console.log(`dialtone-earth origin bridge listening on http://127.0.0.1:${port}`);
    console.log(`  mesh upstream: ${meshOrigin}`);
    console.log(`  test upstream: ${testOrigin}`);
  });
}
