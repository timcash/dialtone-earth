import { computeAdaptivePollMs, type TableQuery } from "./mesh-cadence.ts";
import type { MeshNetwork } from "./simulation.ts";

export type QuerySource = "channel" | "cloudflare";

export type RateTier = "base" | "slow" | "med" | "fast";

export type SplitLayout = "1" | "1|1" | "1/1" | "1|2" | "2x2";

export type LayoutPreference = "auto" | SplitLayout;

export const GLOBE_PANE_ID = "globe";

export const MOBILE_BREAKPOINT_PX = 900;

export function resolveEffectiveLayout(
  pref: LayoutPreference,
  viewportWidth: number,
): SplitLayout {
  // Mobile viewports must strictly stay single-column (never 1|1, 1|2, or 2x2).
  if (viewportWidth < MOBILE_BREAKPOINT_PX) {
    return pref === "1" ? "1" : "1/1";
  }
  if (pref !== "auto") return pref;
  return "1|1";
}

export interface SavedQuery {
  id: string;
  label: string;
  kind: TableQuery;
  source: QuerySource;
  networkSlug: string;
  rate: RateTier;
  /** Runtime best-effort telemetry counters */
  ticks: number;
  deltas: number;
  notModified: number;
  unchangedStreak: number;
  lastUpdatedAt: string | null;
  estBytesPerSec: number;
  nextDueAtMs: number;
}

export const RATE_TIER_BASE_MS: Record<RateTier, number> = {
  base: 30_000,
  slow: 10_000,
  med: 4_000,
  fast: 1_500,
};

export const SPLIT_LAYOUTS: Array<{
  id: SplitLayout;
  label: string;
  panes: number;
  title: string;
}> = [
  { id: "1", label: "1", panes: 1, title: "Single table" },
  { id: "1|1", label: "1|1", panes: 2, title: "Left / Right split" },
  { id: "1/1", label: "1/1", panes: 2, title: "Top / Bottom split" },
  {
    id: "1|2",
    label: "1|2",
    panes: 3,
    title: "Left half + right half split into 2 (3 panes)",
  },
  { id: "2x2", label: "2x2", panes: 4, title: "Quad 2×2 split" },
];

export function paneCountForLayout(layout: SplitLayout): number {
  const found = SPLIT_LAYOUTS.find((item) => item.id === layout);
  return found ? found.panes : 1;
}

export function defaultSourceForKind(kind: TableQuery): QuerySource {
  if (kind === "users" || kind === "networks") {
    return "cloudflare";
  }
  return "channel";
}

export function createDefaultQuerySet(
  networks: MeshNetwork[],
  nowMs = Date.now(),
): SavedQuery[] {
  const primary = networks[0]?.slug ?? "sim-atlas";
  const secondary = networks[1]?.slug ?? primary;
  const make = (
    id: string,
    label: string,
    kind: TableQuery,
    source: QuerySource,
    networkSlug: string,
    rate: RateTier,
  ): SavedQuery => ({
    id,
    label,
    kind,
    source,
    networkSlug,
    rate,
    ticks: 0,
    deltas: 0,
    notModified: 0,
    unchangedStreak: 0,
    lastUpdatedAt: null,
    estBytesPerSec: 0,
    nextDueAtMs: nowMs,
  });

  return [
    make("q-networks", "mesh:networks", "networks", "cloudflare", primary, "base"),
    make("q-hosts", `${primary}:hosts`, "hosts", "channel", primary, "med"),
    make("q-plugins", `${primary}:plugins`, "plugins", "channel", primary, "slow"),
    make("q-users", "cf:users", "users", "cloudflare", primary, "slow"),
    make("q-recovery", `${secondary}:recovery`, "recovery", "channel", secondary, "slow"),
    make("q-tests", `${primary}:tests`, "tests", "channel", primary, "base"),
    make("q-log", `${primary}:log`, "log", "channel", primary, "base"),
  ];
}

export function createCustomQuery(
  existing: SavedQuery[],
  input: {
    label?: string;
    kind: TableQuery;
    source: QuerySource;
    networkSlug: string;
    rate: RateTier;
  },
  nowMs = Date.now(),
): SavedQuery {
  const idx = existing.length + 1;
  const cleanLabel =
    (input.label ?? "").trim() ||
    `${input.source === "cloudflare" ? "cf" : input.networkSlug}:${input.kind}`;
  return {
    id: `q-custom-${idx}-${Math.floor(nowMs % 10_000)}`,
    label: cleanLabel.slice(0, 32),
    kind: input.kind,
    source: input.source,
    networkSlug: input.networkSlug,
    rate: input.rate,
    ticks: 0,
    deltas: 0,
    notModified: 0,
    unchangedStreak: 0,
    lastUpdatedAt: null,
    estBytesPerSec: 0,
    nextDueAtMs: nowMs,
  };
}

/**
 * Computes the next best-effort interval for a query given its chosen rate
 * tier and unchanged streak. Even "fast" smoothly backs off when nothing
 * changes, and hidden tabs always drop to null (0 traffic).
 */
export function bestEffortIntervalMs(
  rate: RateTier,
  unchangedStreak: number,
  hidden: boolean,
  random = 0.5,
): number | null {
  if (hidden) return null;
  const adaptive = computeAdaptivePollMs({
    unchangedStreak,
    hidden: false,
    random,
  });
  const baseTarget = RATE_TIER_BASE_MS[rate];
  const jitter = 0.9 + Math.max(0, Math.min(1, random)) * 0.2;
  const tierFloor = Math.round(baseTarget * jitter);
  if (adaptive === null) return null;
  // Respect user's rate cap while allowing unchanged queries to decay cleanly toward base
  const decayMultiplier =
    unchangedStreak <= 1
      ? 1
      : unchangedStreak === 2
        ? 1.5
        : unchangedStreak === 3
          ? 2.2
          : 3.0;
  return Math.min(30_000, Math.round(tierFloor * decayMultiplier));
}

/**
 * Best-effort simulated gossip tick for ONE visible query:
 * - Updates only the targeted network's live simulated telemetry metrics
 *   (CPU, RTT, probes) on a probabilistic delta cadence so some polls return
 *   unchanged (0-byte 304) and others deliver crisp deltas.
 * - Never touches minimized or non-visible queries (their estBytesPerSec = 0).
 */
export function tickSimulatedQuery(
  query: SavedQuery,
  networks: MeshNetwork[],
  nowMs: number,
  seed: number,
): boolean {
  query.ticks += 1;
  const net =
    networks.find((n) => n.slug === query.networkSlug) ?? networks[0];
  if (!net) return false;

  // Deterministic pseudo-random wave so telemetry breathes naturally without chaos
  const wave = Math.abs(Math.sin(seed * 1.73 + query.ticks * 0.91));
  const hasDelta =
    query.ticks === 1 ||
    (query.kind === "hosts" || query.kind === "host" || query.kind === "networks"
      ? wave > 0.38
      : wave > 0.65);

  if (!hasDelta) {
    query.notModified += 1;
    query.unchangedStreak += 1;
    const intervalSec = Math.max(
      1.5,
      (bestEffortIntervalMs(query.rate, query.unchangedStreak, false, 0.5) ??
        30_000) / 1000,
    );
    // 304 header-only overhead (~48 bytes)
    query.estBytesPerSec = Math.max(1, Math.round(48 / intervalSec));
    return false;
  }

  query.deltas += 1;
  query.unchangedStreak = 0;
  query.lastUpdatedAt = new Date(nowMs).toISOString().slice(11, 19) + "Z";

  // Apply gentle realistic telemetry delta to simulated hosts in this network
  if (net.simulated && (query.kind === "hosts" || query.kind === "host" || query.kind === "networks")) {
    for (let i = 0; i < net.hosts.length; i += 1) {
      const h = net.hosts[i];
      const deltaCpu = Math.round(Math.sin(nowMs * 0.001 + i * 2.1) * 2.5);
      const curCpu = h.stats.cpu_percent ?? 25;
      h.stats.cpu_percent = Math.max(4, Math.min(96, curCpu + deltaCpu));
      if (typeof h.rtt_ms === "number" && h.rtt_ms > 0) {
        const deltaRtt = Math.sin(nowMs * 0.0013 + i * 1.7) * 0.9;
        h.rtt_ms = Math.max(1.2, Math.round((h.rtt_ms + deltaRtt) * 10) / 10);
      }
    }
  }

  const approxPayloadBytes =
    query.kind === "log"
      ? 640
      : query.kind === "hosts" || query.kind === "networks"
        ? 380
        : 260;
  const intervalSec = Math.max(1.5, RATE_TIER_BASE_MS[query.rate] / 1000);
  query.estBytesPerSec = Math.round(approxPayloadBytes / intervalSec);
  return true;
}

/**
 * Ensures paneAssignments has `paneCount` valid content IDs ("globe" or a
 * SavedQuery.id), defaulting pane #1 to "globe" when empty so the globe is a
 * first-class window panel alongside query tables.
 */
export function normalizePaneAssignments(
  current: string[],
  queries: SavedQuery[],
  layout: SplitLayout,
): string[] {
  const count = paneCountForLayout(layout);
  if (queries.length === 0) return Array.from({ length: count }, () => GLOBE_PANE_ID);
  const validIds = new Set(queries.map((q) => q.id));
  validIds.add(GLOBE_PANE_ID);
  const next: string[] = [];

  for (let i = 0; i < count; i += 1) {
    const existing = current[i];
    if (existing && validIds.has(existing)) {
      next.push(existing);
    } else if (i === 0 && !next.includes(GLOBE_PANE_ID)) {
      next.push(GLOBE_PANE_ID);
    } else {
      const unused = queries.find((q) => !next.includes(q.id));
      next.push((unused ?? queries[i % queries.length]).id);
    }
  }
  return next;
}
