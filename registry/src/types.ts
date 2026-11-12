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

export type NetworkNode = {
  name?: string;
  os?: string;
  arch?: string;
  version?: string;
  relay_region?: string;
  lat?: number;
  lng?: number;
  heard?: number;
  online?: boolean;
  rtt_ms_from_grok_bot_metal?: number | null;
};

export type NetworkSnapshot = {
  network?: string;
  generated_at?: string;
  coordinates_generated_at?: string;
  telemetry_generated_at?: string;
  telemetry_source?: string;
  latest_release?: string;
  node_count?: number;
  nodes: NetworkNode[];
};
