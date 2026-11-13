import type { NodeStats } from "./types";

export const NODE_LOAD_COLORS = {
  low: "#36d66b",
  medium: "#f1c84b",
  high: "#ef4136",
  unavailable: "#9c9c9c",
} as const;

export const NODE_DOT_RADIUS_RATIO = 0.025 / 2.8;

/**
 * The overview marker represents the busier of CPU and RAM. This prevents a
 * quiet CPU from hiding memory pressure while never filling in missing data.
 */
export function nodeLoadPercent(
  stats: NodeStats | undefined,
): number | null {
  if (!stats) return null;
  const values = [stats.cpu_percent, stats.mem_percent].filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
  if (values.length === 0) return null;
  return Math.min(100, Math.max(0, ...values));
}

export function nodeLoadColor(stats: NodeStats | undefined): string {
  const load = nodeLoadPercent(stats);
  if (load === null) return NODE_LOAD_COLORS.unavailable;
  if (load <= 50) {
    return interpolateHex(
      NODE_LOAD_COLORS.low,
      NODE_LOAD_COLORS.medium,
      load / 50,
    );
  }
  return interpolateHex(
    NODE_LOAD_COLORS.medium,
    NODE_LOAD_COLORS.high,
    (load - 50) / 50,
  );
}

function interpolateHex(from: string, to: string, amount: number): string {
  const start = parseHex(from);
  const end = parseHex(to);
  const channel = (key: keyof typeof start) =>
    Math.round(start[key] + (end[key] - start[key]) * amount);
  return `#${[channel("red"), channel("green"), channel("blue")]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

function parseHex(value: string): {
  red: number;
  green: number;
  blue: number;
} {
  return {
    red: Number.parseInt(value.slice(1, 3), 16),
    green: Number.parseInt(value.slice(3, 5), 16),
    blue: Number.parseInt(value.slice(5, 7), 16),
  };
}
