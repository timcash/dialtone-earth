export type NetworkIndexEntry = {
  slug: string;
  name: string;
  node_count: number;
  online_count: number;
  latest_release: string;
  generated_at: string;
};

export type NetworkIndex = {
  networks: NetworkIndexEntry[];
};

export type NodeStats = {
  cpu_cores: number | null;
  cpu_percent: number | null;
  mem_percent: number | null;
  mem_total_bytes: number | null;
  mem_used_bytes: number | null;
  disk_percent: number | null;
  disk_total_bytes: number | null;
  disk_used_bytes: number | null;
  gpu_mem_total_bytes: number | null;
  gpu_mem_used_bytes: number | null;
  load_avg_1m: number | null;
};

export type NodeResources = {
  cpu_logical_cores?: number | null;
  mem_bytes?: number | null;
  disk_bytes?: number | null;
  gpu_mem_bytes?: number | null;
  load_1m?: number | null;
};

export type NetworkNode = {
  name: string;
  os: string;
  arch: string;
  version: string;
  relay_region: string;
  lat: number;
  lng: number;
  heard: number;
  online: boolean;
  rtt_ms?: number | null;
  rtt_ms_from_grok_bot_metal?: number | null;
  stats: NodeStats;
  resources?: NodeResources;
};

export type NetworkSnapshot = {
  network: string;
  generated_at: string;
  coordinates_generated_at?: string;
  telemetry_generated_at?: string;
  telemetry_source?: string;
  latest_release: string;
  node_count: number;
  nodes: NetworkNode[];
  stats_note?: string;
};

export type OverviewNetwork = {
  slug: string;
  snapshot: NetworkSnapshot;
};
