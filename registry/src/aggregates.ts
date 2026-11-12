import type { NetworkSnapshot, NodeStats } from "./types";

export type NetworkMetrics = {
  cpu: string;
  memory: string;
  disk: string;
  gpuMemory: string;
  load: string;
};

export function aggregateNetwork(snapshot: NetworkSnapshot): NetworkMetrics {
  const stats = snapshot.nodes.map((node) => node.stats);
  return {
    cpu: aggregateCpu(stats),
    memory: aggregateCapacity(stats, "mem"),
    disk: aggregateCapacity(stats, "disk"),
    gpuMemory: aggregateGpuMemory(stats),
    load: aggregateLoad(stats),
  };
}

function aggregateCpu(stats: NodeStats[]): string {
  const cores = reported(stats.map((item) => item.cpu_cores));
  if (stats.length > 0 && cores.length === stats.length) {
    return `${formatNumber(sum(cores), 0)} cores`;
  }
  return formatAveragePercent(reported(stats.map((item) => item.cpu_percent)));
}

function aggregateCapacity(
  stats: NodeStats[],
  kind: "mem" | "disk",
): string {
  const totals = reported(
    stats.map((item) =>
      kind === "mem" ? item.mem_total_bytes : item.disk_total_bytes,
    ),
  );
  const used = reported(
    stats.map((item) =>
      kind === "mem" ? item.mem_used_bytes : item.disk_used_bytes,
    ),
  );
  if (
    stats.length > 0 &&
    totals.length === stats.length &&
    used.length === stats.length
  ) {
    return formatBytePair(sum(used), sum(totals));
  }
  const percentages = reported(
    stats.map((item) =>
      kind === "mem" ? item.mem_percent : item.disk_percent,
    ),
  );
  return formatAveragePercent(percentages);
}

function aggregateGpuMemory(stats: NodeStats[]): string {
  const totals = reported(stats.map((item) => item.gpu_mem_total_bytes));
  const used = reported(stats.map((item) => item.gpu_mem_used_bytes));
  if (totals.length === 0 && used.length === 0) return "n/a";
  if (totals.length > 0 && totals.length === used.length) {
    return formatBytePair(sum(used), sum(totals));
  }
  if (totals.length > 0) return formatBytes(sum(totals));
  return `${formatBytes(sum(used))} used`;
}

function aggregateLoad(stats: NodeStats[]): string {
  const values = reported(stats.map((item) => item.load_avg_1m));
  if (values.length === 0) return "n/a";
  return `${formatNumber(average(values), 2)} avg`;
}

function formatAveragePercent(values: number[]): string {
  if (values.length === 0) return "n/a";
  return `${formatNumber(average(values), 1)}% avg`;
}

function formatBytePair(used: number, total: number): string {
  const { divisor, suffix, fractionDigits } = byteUnit(total);
  return `${formatNumber(used / divisor, fractionDigits)}/${formatNumber(total / divisor, fractionDigits)} ${suffix}`;
}

function formatBytes(value: number): string {
  const { divisor, suffix, fractionDigits } = byteUnit(value);
  return `${formatNumber(value / divisor, fractionDigits)} ${suffix}`;
}

function byteUnit(value: number): {
  divisor: number;
  suffix: string;
  fractionDigits: number;
} {
  if (value >= 1_000_000_000_000) {
    return { divisor: 1_000_000_000_000, suffix: "TB", fractionDigits: 2 };
  }
  if (value >= 1_000_000_000) {
    return { divisor: 1_000_000_000, suffix: "GB", fractionDigits: 1 };
  }
  return { divisor: 1_000_000, suffix: "MB", fractionDigits: 1 };
}

function reported(values: Array<number | null>): number[] {
  return values.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function average(values: number[]): number {
  return sum(values) / values.length;
}

function formatNumber(value: number, fractionDigits: number): string {
  return value.toFixed(fractionDigits).replace(/\.0+$/, "");
}
