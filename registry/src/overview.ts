// Optional per-node resources. The byte fields describe installed capacity
// and load_1m is an unnormalized one-minute load average.
export const resourceColumns = [
  { key: "cpu_logical_cores", label: "CPU" },
  { key: "mem_bytes", label: "MEM" },
  { key: "disk_bytes", label: "DISK" },
  { key: "gpu_mem_bytes", label: "GPU MEM" },
  { key: "load_1m", label: "Load" },
] as const;

type ResourceKey = (typeof resourceColumns)[number]["key"];
type ResourceSummary = {
  value: number | null;
  reporting: number;
  expected: number | null;
  partial: boolean;
};

export type OverviewEntry = { slug: string; name: string; node_count?: number };
type Coordinates = { lat: number; lng: number };
type MappedNode = Coordinates & { name: string };

export type SnapshotTime = { label: string; dateTime: string; text: string };

export type NetworkOverview = {
  slug: string;
  name: string;
  nodeCount: number | null;
  snapshotStatus: "available" | "partial" | "unavailable";
  times: SnapshotTime[];
  resources: Record<ResourceKey, ResourceSummary>;
  nodes: MappedNode[];
};

export type GlobePlan = {
  groups: { slug: string; nodes: MappedNode[] }[];
  stops: (Coordinates & { network: string; node: string | null })[];
};

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
}

const utcTimestamp = new Intl.DateTimeFormat("en-GB", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

function snapshotTime(label: string, value: unknown): SnapshotTime | undefined {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return;
  return { label, dateTime: value, text: utcTimestamp.format(new Date(value)) };
}

export function snapshotTimes(snapshot: unknown): SnapshotTime[] {
  const payload = record(snapshot);
  const telemetry = snapshotTime("Telemetry snapshot", payload?.telemetry_generated_at);
  const locations = snapshotTime("Location snapshot", payload?.coordinates_generated_at);
  const original = locations ?? snapshotTime("Network snapshot", payload?.generated_at);
  return [telemetry, original].filter((time) => time !== undefined);
}

function count(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
}

async function readJson(path: string, fetcher: typeof fetch): Promise<unknown> {
  const response = await fetcher(path, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function loadNetworkIndex(fetcher = fetch) {
  const index = record(await readJson("/networks/index.json", fetcher));
  if (!Array.isArray(index?.networks)) throw new Error("Invalid network index");

  const entries: OverviewEntry[] = [];
  for (const value of index.networks) {
    const entry = record(value);
    if (typeof entry?.slug !== "string" || !/^[a-z0-9-]+$/.test(entry.slug) ||
        typeof entry.name !== "string" || !entry.name.trim()) {
      continue;
    }
    entries.push({ slug: entry.slug, name: entry.name, node_count: count(entry.node_count) });
  }
  return { entries, skipped: index.networks.length - entries.length };
}

export async function loadNetworkOverview(
  entry: OverviewEntry,
  fetcher = fetch,
): Promise<NetworkOverview> {
  let snapshot: unknown;
  try {
    snapshot = await readJson(`/networks/${encodeURIComponent(entry.slug)}.json`, fetcher);
  } catch {
    return summarizeNetwork(entry);
  }
  return summarizeNetwork(entry, snapshot);
}

export function summarizeNetwork(entry: OverviewEntry, snapshot?: unknown): NetworkOverview {
  const payload = record(snapshot);
  const nodes: unknown[] | null = Array.isArray(payload?.nodes) ? payload.nodes : null;
  const declaredCounts = [count(entry.node_count), count(payload?.node_count)]
    .filter((value) => value !== undefined);
  const counts = nodes ? [...declaredCounts, nodes.length] : declaredCounts;
  const nodeCount = counts.length ? Math.max(...counts) : null;
  // A discrepancy can leave nodes unaccounted for even when every listed
  // node reports resources. Use the largest count and mark it as partial.
  const complete = nodes !== null && declaredCounts.length > 0 &&
    declaredCounts.every((total) => total === nodes.length) &&
    nodes.every((node) => record(node) !== undefined);

  const resources = {} as NetworkOverview["resources"];
  for (const { key } of resourceColumns) {
    let total = 0;
    let reporting = 0;
    for (const node of nodes ?? []) {
      const value = record(record(node)?.resources)?.[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
      if (key !== "load_1m" && !Number.isSafeInteger(value)) continue;
      reporting += 1;
      total += key === "load_1m" ? (value - total) / reporting : value;
    }
    resources[key] = {
      value: reporting > 0 ? total : null,
      reporting,
      expected: nodeCount,
      partial: !complete || reporting !== nodeCount,
    };
  }

  return {
    slug: entry.slug,
    name: entry.name,
    nodeCount,
    snapshotStatus: complete ? "available" : nodes ? "partial" : "unavailable",
    times: snapshotTimes(snapshot),
    resources,
    nodes: (nodes ?? []).flatMap((value) => {
      const node = record(value);
      const lat = node?.lat;
      const lng = node?.lng;
      if (typeof node?.name !== "string" || !node.name.trim() ||
          typeof lat !== "number" || !(lat >= -90 && lat <= 90) ||
          typeof lng !== "number" || !(lng >= -180 && lng <= 180)) return [];
      return [{ name: node.name, lat, lng }];
    }),
  };
}

const quantity = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });
const byteUnits = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];

function formatBytes(value: number): string {
  let unit = 0;
  while (value >= 1024 && unit < byteUnits.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${quantity.format(value)} ${byteUnits[unit]}`;
}

export function formatResource(key: ResourceKey, resource: ResourceSummary): string {
  const { value, reporting, expected, partial } = resource;
  if (value === null) return "Unavailable";

  const formatted = key === "load_1m"
    ? (value > 0 && value < 0.01 ? "<0.01" : quantity.format(value))
    : key === "cpu_logical_cores"
      ? `${quantity.format(value)} ${value === 1 ? "core" : "cores"}`
      : formatBytes(value);
  if (!partial) return formatted;
  const coverage = expected !== null && reporting < expected
    ? `${reporting}/${expected} nodes`
    : `${reporting} reporting`;
  return `${formatted} (partial, ${coverage})`;
}

export function createGlobePlan(networks: NetworkOverview[]): GlobePlan {
  const groups: GlobePlan["groups"] = [];
  const stops: GlobePlan["stops"] = [];
  for (const { slug, name, nodes } of networks) {
    if (!nodes.length) continue;
    groups.push({ slug, nodes });
    stops.push({ ...geographicCenter(nodes), network: name, node: null });
    for (const { lat, lng, name: node } of nodes) {
      stops.push({ lat, lng, network: name, node });
    }
  }
  return { groups, stops };
}

function geographicCenter(nodes: MappedNode[]): Coordinates {
  const radians = Math.PI / 180;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const { lat, lng } of nodes) {
    const latitude = lat * radians;
    const longitude = lng * radians;
    const horizontalRadius = Math.cos(latitude);
    x += horizontalRadius * Math.cos(longitude);
    y += horizontalRadius * Math.sin(longitude);
    z += Math.sin(latitude);
  }
  const horizontal = Math.hypot(x, y);
  // A symmetric set of locations can cancel out and leave no unique center.
  if (Math.hypot(horizontal, z) < 1e-10 * nodes.length) {
    const { lat, lng } = nodes[0];
    return { lat, lng };
  }
  return {
    lat: Math.atan2(z, horizontal) / radians,
    lng: Math.atan2(y, x) / radians,
  };
}
