import type { KvNamespaceBinding } from "./auth.ts";

export type PersistedLayout = "auto" | "1" | "1|1" | "1/1" | "1|2" | "2x2";
export type PersistedQueryKind =
  | "networks"
  | "hosts"
  | "host"
  | "plugins"
  | "recovery"
  | "users"
  | "tests"
  | "log";
export type PersistedQuerySource = "channel" | "cloudflare";
export type PersistedRateTier = "base" | "slow" | "med" | "fast";

export interface PersistedQuerySpec {
  id: string;
  label: string;
  kind: PersistedQueryKind;
  source: PersistedQuerySource;
  networkSlug: string;
  rate: PersistedRateTier;
}

export interface PersistedUserUiConfig {
  version: 2;
  layout: PersistedLayout;
  /** Each entry is "globe" or a query ID from `queries` */
  paneContents: string[];
  queries: PersistedQuerySpec[];
  cameraPolicyCode: string;
  theme?: "dark" | "light";
  updated_at?: string;
}

const VALID_LAYOUTS = new Set<PersistedLayout>([
  "auto",
  "1",
  "1|1",
  "1/1",
  "1|2",
  "2x2",
]);
const VALID_KINDS = new Set<PersistedQueryKind>([
  "networks",
  "hosts",
  "host",
  "plugins",
  "recovery",
  "users",
  "tests",
  "log",
]);
const VALID_SOURCES = new Set<PersistedQuerySource>(["channel", "cloudflare"]);
const VALID_RATES = new Set<PersistedRateTier>(["base", "slow", "med", "fast"]);

const MAX_BODY_BYTES = 32_768;
const MAX_QUERIES = 24;
const MAX_PANES = 4;
const MAX_CAMERA_CODE_CHARS = 8_192;

export function userUiConfigKey(host: string, subject: string): string {
  const cleanHost = host.trim().toLowerCase().replace(/[^a-z0-9.-]/g, "");
  const cleanUser = subject.trim().toLowerCase().replace(/[^a-z0-9@._+-]/g, "");
  return `user-ui-config:${cleanHost}:${cleanUser}`;
}

function cleanShortStr(value: unknown, maxLen: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, maxLen);
}

export function sanitizePersistedUiConfig(
  raw: unknown,
  nowIso: string,
): PersistedUserUiConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const layoutRaw =
    typeof obj.layout === "string" ? (obj.layout.trim() as PersistedLayout) : "auto";
  const layout: PersistedLayout = VALID_LAYOUTS.has(layoutRaw) ? layoutRaw : "auto";

  const queries: PersistedQuerySpec[] = [];
  const seenIds = new Set<string>();
  if (Array.isArray(obj.queries)) {
    for (const item of obj.queries.slice(0, MAX_QUERIES)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const q = item as Record<string, unknown>;
      const id = cleanShortStr(q.id, 48).replace(/[^a-zA-Z0-9_-]/g, "");
      if (!id || id === "globe" || seenIds.has(id)) continue;
      const kind = String(q.kind ?? "") as PersistedQueryKind;
      if (!VALID_KINDS.has(kind)) continue;
      const source = String(q.source ?? "channel") as PersistedQuerySource;
      const rate = String(q.rate ?? "med") as PersistedRateTier;
      const networkSlug =
        cleanShortStr(q.networkSlug, 48)
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "") || "sim-atlas";
      const label = cleanShortStr(q.label, 36) || `${networkSlug}:${kind}`;
      seenIds.add(id);
      queries.push({
        id,
        label,
        kind,
        source: VALID_SOURCES.has(source) ? source : "channel",
        networkSlug,
        rate: VALID_RATES.has(rate) ? rate : "med",
      });
    }
  }

  const paneContents: string[] = [];
  if (Array.isArray(obj.paneContents)) {
    for (const entry of obj.paneContents.slice(0, MAX_PANES)) {
      const cleaned = cleanShortStr(entry, 48);
      if (cleaned === "globe" || seenIds.has(cleaned)) {
        paneContents.push(cleaned);
      }
    }
  }
  if (paneContents.length === 0) {
    paneContents.push("globe");
    if (queries[0]) paneContents.push(queries[0].id);
  }

  const cameraPolicyCode =
    typeof obj.cameraPolicyCode === "string"
      ? obj.cameraPolicyCode.replace(/\u0000/g, "").slice(0, MAX_CAMERA_CODE_CHARS)
      : "";

  const theme =
    obj.theme === "light" || obj.theme === "dark" ? obj.theme : undefined;

  return {
    version: 2,
    layout,
    paneContents,
    queries,
    cameraPolicyCode,
    ...(theme ? { theme } : {}),
    updated_at: nowIso,
  };
}

export async function handleUserUiConfigRoute(options: {
  request: Request;
  kv?: KvNamespaceBinding;
  host: string;
  subject: string;
  nowSec: number;
  securityHeaders: Record<string, string>;
}): Promise<Response> {
  const { request, kv, host, subject, nowSec, securityHeaders } = options;
  const json = (payload: unknown, status: number): Response => {
    const headers = new Headers(securityHeaders);
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Cache-Control", "private, no-store");
    return new Response(JSON.stringify(payload, null, 2), { status, headers });
  };

  if (!kv) {
    return json({ error: "UI config KV storage is not configured" }, 503);
  }

  const key = userUiConfigKey(host, subject);

  if (request.method === "GET" || request.method === "HEAD") {
    const raw = await kv.get(key);
    if (!raw) {
      return json({ saved: false, subject, host, config: null }, 200);
    }
    try {
      const parsed = JSON.parse(raw) as PersistedUserUiConfig;
      return json(
        {
          saved: true,
          subject,
          host,
          updated_at: parsed.updated_at ?? null,
          config: parsed,
        },
        200,
      );
    } catch {
      return json({ saved: false, subject, host, config: null }, 200);
    }
  }

  if (request.method === "DELETE") {
    await kv.delete(key);
    return json({ ok: true, cleared: true, subject, host }, 200);
  }

  if (request.method !== "PUT") {
    return json({ error: "Method not allowed; use GET, PUT, or DELETE" }, 405);
  }

  const rawText = await request.text();
  if (rawText.length > MAX_BODY_BYTES) {
    return json({ error: "UI config payload exceeds 32 KB limit" }, 413);
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawText);
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const nowIso = new Date(nowSec * 1000).toISOString();
  const sanitized = sanitizePersistedUiConfig(parsedBody, nowIso);
  if (!sanitized) {
    return json({ error: "Invalid UI config object" }, 400);
  }

  await kv.put(key, JSON.stringify(sanitized));
  return json(
    {
      ok: true,
      saved: true,
      subject,
      host,
      updated_at: nowIso,
      config: sanitized,
    },
    200,
  );
}
