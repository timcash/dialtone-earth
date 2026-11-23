import type { KvNamespaceBinding } from "./auth.ts";
import { redactSecrets } from "./redact.ts";

export interface PresenceLocation {
  sessionId: string;
  location: string;
  city: string | null;
  region: string | null;
  country: string | null;
  colo: string | null;
  viewingView: string;
  viewingNode: string | null;
  lastSeenAt: string;
}

export interface StoredPresenceRecord extends PresenceLocation {
  subject: string;
  hostname: string;
}

export interface AggregatedUserPresence {
  email: string;
  role: string;
  status: "active" | "idle";
  locations: PresenceLocation[];
  shellNodes: string[];
  lastCommandAt: string | null;
}

export interface RedactedShellAuditEntry {
  id: string;
  timestamp: string;
  user: string;
  node: string;
  sessionName: string;
  shell: "bash" | "powershell";
  cwd: string;
  command: string;
  output: string;
  redactedCount: number;
}

const PRESENCE_TTL_SEC = 900; // 15 minutes
const ALLOWED_VIEWS = new Set([
  "overview",
  "network",
  "host",
  "users",
  "tests",
  "log",
]);
const NODE_NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;

interface CloudflareRequestCf {
  city?: string;
  region?: string;
  regionCode?: string;
  country?: string;
  colo?: string;
}

export function presenceKey(host: string, sid: string): string {
  return `presence:${host.toLowerCase()}:${sid}`;
}

export function extractEdgeLocation(request: Request): {
  location: string;
  city: string | null;
  region: string | null;
  country: string | null;
  colo: string | null;
} {
  const cf = (request as Request & { cf?: CloudflareRequestCf }).cf;
  const city = cleanGeo(cf?.city);
  const region = cleanGeo(cf?.regionCode || cf?.region);
  const country = cleanGeo(cf?.country);
  const colo = cleanGeo(cf?.colo);

  const parts = [city, region, country].filter((v): v is string => Boolean(v));
  let location = parts.join(", ");
  if (colo) {
    location = location ? `${location} (${colo})` : `Edge ${colo}`;
  }
  if (!location) {
    location = "Edge session";
  }
  return { location, city, region, country, colo };
}

export function normalizePresenceView(raw: unknown): string {
  if (typeof raw === "string" && ALLOWED_VIEWS.has(raw.trim())) {
    return raw.trim();
  }
  return "overview";
}

export function normalizePresenceNode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || !NODE_NAME_RE.test(trimmed)) return null;
  return trimmed;
}

export async function recordUserPresence(
  kv: KvNamespaceBinding | undefined,
  opts: {
    request: Request;
    host: string;
    subject: string;
    sessionId: string;
    viewingView?: string;
    viewingNode?: string | null;
    nowSec: number;
    preserveExistingView?: boolean;
  },
): Promise<StoredPresenceRecord> {
  const key = presenceKey(opts.host, opts.sessionId);
  const geo = extractEdgeLocation(opts.request);
  let viewingView = opts.viewingView ?? "overview";
  let viewingNode = opts.viewingNode ?? null;

  if (kv && opts.preserveExistingView) {
    const existingRaw = await kv.get(key);
    if (existingRaw) {
      try {
        const existing = JSON.parse(existingRaw) as Partial<StoredPresenceRecord>;
        if (typeof existing.viewingView === "string") {
          viewingView = normalizePresenceView(existing.viewingView);
        }
        if (existing.viewingNode !== undefined) {
          viewingNode = normalizePresenceNode(existing.viewingNode);
        }
      } catch {
        // Ignore malformed record and overwrite cleanly.
      }
    }
  }

  const record: StoredPresenceRecord = {
    sessionId: opts.sessionId,
    subject: opts.subject.toLowerCase(),
    hostname: opts.host.toLowerCase(),
    location: geo.location,
    city: geo.city,
    region: geo.region,
    country: geo.country,
    colo: geo.colo,
    viewingView,
    viewingNode,
    lastSeenAt: new Date(opts.nowSec * 1000).toISOString(),
  };

  if (kv) {
    await kv.put(key, JSON.stringify(record), {
      expirationTtl: PRESENCE_TTL_SEC,
    });
  }
  return record;
}

export async function clearUserPresence(
  kv: KvNamespaceBinding | undefined,
  host: string,
  sessionId: string | undefined,
): Promise<void> {
  if (!kv || !sessionId) return;
  await kv.delete(presenceKey(host, sessionId));
}

export async function listNetworkPresence(
  kv: KvNamespaceBinding | undefined,
  host: string,
  fallbackCurrent: StoredPresenceRecord,
  auditLog: RedactedShellAuditEntry[],
  nowSec: number,
): Promise<AggregatedUserPresence[]> {
  const records: StoredPresenceRecord[] = [];
  const prefix = `presence:${host.toLowerCase()}:`;

  if (kv && typeof kv.list === "function") {
    const listed = await kv.list({ prefix });
    for (const item of listed.keys) {
      const raw = await kv.get(item.name);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as StoredPresenceRecord;
        if (parsed.subject && parsed.sessionId) {
          records.push(parsed);
        }
      } catch {
        // Skip unreadable record
      }
    }
  }

  if (!records.some((r) => r.sessionId === fallbackCurrent.sessionId)) {
    records.push(fallbackCurrent);
  }

  const byEmail = new Map<string, PresenceLocation[]>();
  for (const rec of records) {
    const email = rec.subject.toLowerCase();
    const list = byEmail.get(email) ?? [];
    list.push({
      sessionId: rec.sessionId,
      location: rec.location,
      city: rec.city,
      region: rec.region,
      country: rec.country,
      colo: rec.colo,
      viewingView: rec.viewingView,
      viewingNode: rec.viewingNode,
      lastSeenAt: rec.lastSeenAt,
    });
    byEmail.set(email, list);
  }

  const users: AggregatedUserPresence[] = [];
  for (const [email, locations] of byEmail.entries()) {
    locations.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    const latestMs = Date.parse(locations[0]?.lastSeenAt ?? "");
    const idleSec = Number.isFinite(latestMs)
      ? Math.max(0, nowSec - Math.floor(latestMs / 1000))
      : 0;

    const matchingCommands = auditLog.filter(
      (entry) => entry.user.toLowerCase() === email,
    );
    const shellNodes = Array.from(
      new Set(
        matchingCommands
          .map((entry) => entry.node)
          .filter((node) => node.length > 0),
      ),
    );

    users.push({
      email,
      role: "authorized-member",
      status: idleSec <= 300 ? "active" : "idle",
      locations,
      shellNodes,
      lastCommandAt: matchingCommands[0]?.timestamp ?? null,
    });
  }

  users.sort((a, b) => {
    const aTime = a.locations[0]?.lastSeenAt ?? "";
    const bTime = b.locations[0]?.lastSeenAt ?? "";
    return bTime.localeCompare(aTime);
  });
  return users;
}

export function buildRedactedShellAuditLog(opts: {
  sessionsPayload: Record<string, unknown> | null;
  fullStatePayload: Record<string, unknown> | null;
  defaultNode: string;
  defaultUser: string;
  nowSec: number;
}): RedactedShellAuditEntry[] {
  const entries: RedactedShellAuditEntry[] = [];
  const defaultTs = new Date(opts.nowSec * 1000).toISOString();

  const rawSessions = Array.isArray(opts.sessionsPayload?.sessions)
    ? (opts.sessionsPayload.sessions as unknown[])
    : [];
  rawSessions.forEach((raw, idx) => {
    const s = asRecord(raw);
    const name = asString(s.name) || `session-${idx + 1}`;
    const node = asString(s.node) || opts.defaultNode || "origin";
    const user = asString(s.user) || asString(s.actor) || opts.defaultUser;
    const shell = asString(s.shell).toLowerCase().includes("power")
      ? "powershell"
      : "bash";
    const cwd = asString(s.cwd) || "~";
    const cmdRed = redactSecrets(
      asString(s.last_command) || "(interactive dialtone/shell/1 session)",
    );
    const outRed = redactSecrets(
      asString(s.last_output) || "(connected via dialtone/shell/1)",
    );
    const tsUnix = asNumber(s.updated_at_unix) ?? asNumber(s.started_at_unix);

    entries.push({
      id: `shell-session-${idx}-${name}`,
      timestamp: tsUnix ? new Date(tsUnix * 1000).toISOString() : defaultTs,
      user,
      node,
      sessionName: name,
      shell,
      cwd,
      command: cmdRed.text,
      output: outRed.text,
      redactedCount: cmdRed.redactedCount + outRed.redactedCount,
    });
  });

  const rawEvents = Array.isArray(opts.fullStatePayload?.events)
    ? (opts.fullStatePayload.events as unknown[])
    : [];
  rawEvents
    .slice(-30)
    .reverse()
    .forEach((raw, idx) => {
      const ev = asRecord(raw);
      const kind = asString(ev.kind).toLowerCase();
      const message = asString(ev.message);
      if (
        !kind.includes("shell") &&
        !kind.includes("exec") &&
        !kind.includes("cmd") &&
        !message.toLowerCase().includes("shell")
      ) {
        return;
      }
      const tsUnix = asNumber(ev.timestamp_unix);
      const cmdRed = redactSecrets(
        asString(ev.command) || message || kind || "dialtone shell",
      );
      const outRed = redactSecrets(asString(ev.output) || `event: ${kind}`);
      entries.push({
        id: asString(ev.id) || `shell-event-${idx}`,
        timestamp: tsUnix ? new Date(tsUnix * 1000).toISOString() : defaultTs,
        user: asString(ev.user) || asString(ev.actor) || opts.defaultUser,
        node: asString(ev.source) || opts.defaultNode || "origin",
        sessionName: asString(ev.session) || "dialtone/shell/1",
        shell: "bash",
        cwd: asString(ev.cwd) || "~",
        command: cmdRed.text,
        output: outRed.text,
        redactedCount: cmdRed.redactedCount + outRed.redactedCount,
      });
    });

  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return entries;
}

function cleanGeo(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 64) : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
