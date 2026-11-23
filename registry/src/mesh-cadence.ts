export type TableQuery =
  | "networks"
  | "hosts"
  | "host"
  | "plugins"
  | "recovery"
  | "users"
  | "tests"
  | "log";

export const MESH_BACKOFF_STEPS_MS = [2_000, 4_000, 8_000, 15_000, 30_000] as const;

export interface CadenceInput {
  unchangedStreak: number;
  hidden: boolean;
  /** Optional deterministic random in [0, 1) for ±15% anti-herd jitter */
  random?: number;
}

/**
 * Adaptive gossip-mesh sync interval:
 * - Hidden tab: null (0 background traffic; syncs immediately on visibilitychange)
 * - Active delta (streak 0..1): 2s fast convergence
 * - Idle backoff: 4s -> 8s -> 15s -> 30s minimal base traffic
 * - Applies ±15% jitter so browsers on the same mesh never synchronize spikes
 */
export function computeAdaptivePollMs(input: CadenceInput): number | null {
  if (input.hidden) return null;
  const streak = Math.max(0, Math.floor(input.unchangedStreak));
  const stepIdx =
    streak <= 1
      ? 0
      : Math.min(streak - 1, MESH_BACKOFF_STEPS_MS.length - 1);
  const base = MESH_BACKOFF_STEPS_MS[stepIdx];
  const r = typeof input.random === "number" ? input.random : Math.random();
  const jitter = 0.85 + Math.max(0, Math.min(1, r)) * 0.3;
  return Math.round(base * jitter);
}

/**
 * Single-query-only endpoint selection: fetches ONLY the one resource backing
 * the active table query rather than fanning out across all mesh endpoints.
 */
export function liveEndpointForQuery(
  query: TableQuery,
  activeTestId?: string | null,
): string | null {
  switch (query) {
    case "networks":
    case "hosts":
    case "host":
      return "/api/mesh/state";
    case "plugins":
      return "/api/mesh/plugins";
    case "recovery":
      return "/api/mesh/full-state";
    case "users":
      return "/api/mesh/users";
    case "tests":
      return "/api/mesh/tests";
    case "log":
      return activeTestId && /^[a-f0-9]{32}$/.test(activeTestId)
        ? `/api/mesh/test-runs/${activeTestId}`
        : null;
  }
}

export function formatCadenceLabel(
  intervalMs: number | null,
  unchangedStreak: number,
  notModifiedCount: number,
): string {
  if (intervalMs === null) return "MESH PAUSED";
  const secs = Math.max(1, Math.round(intervalMs / 1000));
  const mode =
    unchangedStreak <= 1
      ? "BURST"
      : secs >= 25
        ? "BASE"
        : "DECAY";
  return notModifiedCount > 0
    ? `GOSSIP ${mode} ${secs}s · ${notModifiedCount}×304`
    : `GOSSIP ${mode} ${secs}s`;
}
