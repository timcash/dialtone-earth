import { cellToBoundary, latLngToCell } from "h3-js";
import * as THREE from "three";
import {
  latLngToUnitVec3,
  type GeoNodePoint,
} from "./edge-bundling.ts";
import { nodeLoadColor, nodeLoadPercent } from "./node-load.ts";
import type { SavedQuery } from "./query-workspace.ts";
import type { MeshHost, MeshNetwork } from "./simulation.ts";
import type { NetworkNode } from "./types.ts";

const DEG_TO_RAD = Math.PI / 180;

export const H3_LAYER_COLORS = {
  plugins: 0x46d8ff,
  users: 0xb88aff,
  probesPass: 0x36d66b,
  probesFail: 0xff5a5f,
} as const;

export type H3LayerKind = "load" | "plugins" | "users" | "probes";

export interface H3DataCell {
  cell: string;
  intensity: number;
  colorHex: number;
  layer: H3LayerKind;
  networkIndex: number;
  hosts: string[];
}

export interface GlobeMarkerSpec {
  networkSlug: string;
  networkIndex: number;
  nodeIndex: number;
  node: NetworkNode;
}

export interface GlobeQueryLayers {
  /** Deterministic fingerprint so WebGL geometry only rebuilds when data changes */
  signature: string;
  /** Base node markers from active networks */
  markers: GlobeMarkerSpec[];
  /** Exact res-3 H3 tiles driven strictly by open query tables (0 fake halos) */
  h3Cells: H3DataCell[];
  /** Nodes eligible for RTT ping arcs (only populated when a host/hosts/networks query is open) */
  arcNodes: GeoNodePoint[];
  /** In live mode, draw arcs strictly between peers with real measured peer_rtt_ms */
  onlyMeasuredLinks: boolean;
  /** When only a single-host query is open, focus arcs incident to that host */
  focusHostName: string | null;
  /** Ordered list of active H3 data layers from the visible query set */
  activeLayers: H3LayerKind[];
  /** Exact count of RTT arcs that will be rendered */
  measuredArcCount: number;
  /** Short honest header badge summarizing what is currently drawn */
  legend: string;
  /** Detailed hover explanation of every active layer and color */
  legendTooltip: string;
}

function parseHexColor(cssHex: string): number {
  const clean = cssHex.replace(/^#/, "");
  const parsed = Number.parseInt(clean, 16);
  return Number.isFinite(parsed) ? parsed : 0x9c9c9c;
}

function isHostProbeFailing(host: MeshHost): boolean {
  const summary = (host.probeSummary || "").trim();
  const ratio = summary.match(/^(\d+)\s*\/\s*(\d+)/);
  if (ratio) {
    const passed = Number(ratio[1]);
    const total = Number(ratio[2]);
    if (total > 0 && passed < total) return true;
  }
  return /\b(fail|failed|error|down|offline)\b/i.test(summary) || !host.online;
}

function layerPriority(layer: H3LayerKind, colorHex: number): number {
  if (layer === "probes" && colorHex === H3_LAYER_COLORS.probesFail) return 4;
  if (layer === "users") return 3;
  if (layer === "plugins") return 2;
  if (layer === "probes") return 1;
  return 0;
}

function countRenderableArcs(
  nodes: GeoNodePoint[],
  onlyMeasuredLinks: boolean,
  focusHostName: string | null,
  maxPairsPerNetwork = 34,
): number {
  if (nodes.length < 2) return 0;
  const byNet = new Map<number, GeoNodePoint[]>();
  const units = new Map<string, [number, number, number]>();
  for (const node of nodes) {
    units.set(node.id, latLngToUnitVec3(node.lat, node.lng));
    const list = byNet.get(node.networkIndex) ?? [];
    list.push(node);
    byNet.set(node.networkIndex, list);
  }

  let total = 0;
  for (const netNodes of byNet.values()) {
    let added = 0;
    for (let i = 0; i < netNodes.length; i += 1) {
      for (let j = i + 1; j < netNodes.length; j += 1) {
        if (added >= maxPairsPerNetwork) break;
        const na = netNodes[i];
        const nb = netNodes[j];
        const aName = na.name || na.id.split(":").pop() || na.id;
        const bName = nb.name || nb.id.split(":").pop() || nb.id;
        if (focusHostName && aName !== focusHostName && bName !== focusHostName) {
          continue;
        }
        const uA = units.get(na.id)!;
        const uB = units.get(nb.id)!;
        const d = Math.max(-1, Math.min(1, uA[0] * uB[0] + uA[1] * uB[1] + uA[2] * uB[2]));
        if (Math.acos(d) < 0.004) continue;
        if (onlyMeasuredLinks) {
          const ab = na.peerRttMs?.[bName];
          const ba = nb.peerRttMs?.[aName];
          if (typeof ab !== "number" && typeof ba !== "number") continue;
        }
        added += 1;
        total += 1;
      }
    }
  }
  return total;
}

/**
 * Projects ONLY real network data onto the 3D globe based on the currently open
 * visible Query Set. Every H3 cell is the exact resolution-3 tile containing a
 * matching host (zero invented neighbor rings, zero decorative clusters).
 *
 * - Open `hosts` / `host` / `networks` -> H3 tiles colored by real CPU/RAM load
 *   + bundled RTT ping arcs (measured `peer_rtt_ms` only in live mode).
 * - Open `plugins` -> cyan H3 tiles strictly on hosts with deployed plugins/blobs.
 * - Open `users` -> violet H3 tiles strictly on nodes viewed/shelled by users.
 * - Open `recovery` / `tests` / `log` -> green (all pass) or red (failing) tiles.
 * - No query tables open -> base node markers only (0 H3 tiles, 0 ping arcs).
 */
export function buildQueryDrivenGlobeLayers(
  networks: MeshNetwork[],
  visibleQueries: SavedQuery[],
  selectedHostName: string,
  isSimulated: boolean,
  resolution = 3,
): GlobeQueryLayers {
  const markers: GlobeMarkerSpec[] = [];
  networks.forEach((net, networkIndex) => {
    net.snapshot.nodes.forEach((node, nodeIndex) => {
      markers.push({
        networkSlug: net.slug,
        networkIndex,
        nodeIndex,
        node,
      });
    });
  });

  if (visibleQueries.length === 0) {
    const markerSig = markers
      .map(
        (m) =>
          `${m.networkSlug}:${m.node.name}:${m.node.lat.toFixed(2)},${m.node.lng.toFixed(2)}:${m.node.online ? 1 : 0}:${nodeLoadPercent(m.node.stats) ?? -1}`,
      )
      .join("|");
    return {
      signature: `base|${markerSig}`,
      markers,
      h3Cells: [],
      arcNodes: [],
      onlyMeasuredLinks: !isSimulated,
      focusHostName: null,
      activeLayers: [],
      measuredArcCount: 0,
      legend: "BASE NODES ONLY",
      legendTooltip:
        "No query table open — showing base node markers only. Open hosts, plugins, users, or tests tables to project real H3 tiles and measured RTT arcs.",
    };
  }

  const cellMap = new Map<string, H3DataCell>();
  const activeLayerSet = new Set<H3LayerKind>();
  const arcNodeMap = new Map<string, GeoNodePoint>();
  let hasBroadArcQuery = false;
  let hasSingleHostQuery = false;

  const upsertCell = (
    host: MeshHost,
    networkIndex: number,
    layer: H3LayerKind,
    colorHex: number,
    intensity: number,
  ) => {
    if (!Number.isFinite(host.lat) || !Number.isFinite(host.lng)) return;
    const cell = latLngToCell(host.lat, host.lng, resolution);
    const clampedIntensity = Math.max(0.18, Math.min(1, intensity));
    const existing = cellMap.get(cell);
    if (!existing) {
      cellMap.set(cell, {
        cell,
        intensity: clampedIntensity,
        colorHex,
        layer,
        networkIndex,
        hosts: [host.name],
      });
      return;
    }
    if (!existing.hosts.includes(host.name)) {
      existing.hosts.push(host.name);
    }
    const nextPri = layerPriority(layer, colorHex);
    const curPri = layerPriority(existing.layer, existing.colorHex);
    if (
      nextPri > curPri ||
      (nextPri === curPri && clampedIntensity > existing.intensity)
    ) {
      existing.layer = layer;
      existing.colorHex = colorHex;
      existing.intensity = Math.max(existing.intensity, clampedIntensity);
    }
  };

  const addArcNetwork = (net: MeshNetwork, networkIndex: number) => {
    for (const host of net.hosts) {
      const id = `${net.slug}:${host.name}`;
      if (!arcNodeMap.has(id)) {
        arcNodeMap.set(id, {
          id,
          name: host.name,
          networkIndex,
          lat: host.lat,
          lng: host.lng,
          rttMs: host.rtt_ms ?? null,
          peerRttMs: host.peer_rtt_ms,
        });
      }
    }
  };

  const resolveTargetNetworks = (q: SavedQuery): Array<{ net: MeshNetwork; idx: number }> => {
    if (q.kind === "networks") {
      return networks.map((net, idx) => ({ net, idx }));
    }
    const idx = networks.findIndex((n) => n.slug === q.networkSlug);
    if (idx >= 0) return [{ net: networks[idx], idx }];
    return networks[0] ? [{ net: networks[0], idx: 0 }] : [];
  };

  for (const q of visibleQueries) {
    const targets = resolveTargetNetworks(q);
    for (const { net, idx } of targets) {
      if (q.kind === "networks" || q.kind === "hosts" || q.kind === "host") {
        activeLayerSet.add("load");
        addArcNetwork(net, idx);
        if (q.kind === "host") {
          hasSingleHostQuery = true;
          const picked =
            net.hosts.find((h) => h.name === selectedHostName) ?? net.hosts[0];
          if (picked) {
            const load = nodeLoadPercent(picked.stats);
            upsertCell(
              picked,
              idx,
              "load",
              parseHexColor(nodeLoadColor(picked.stats)),
              load !== null ? Math.max(0.22, load / 100) : 0.25,
            );
          }
        } else {
          hasBroadArcQuery = true;
          for (const host of net.hosts) {
            const load = nodeLoadPercent(host.stats);
            upsertCell(
              host,
              idx,
              "load",
              parseHexColor(nodeLoadColor(host.stats)),
              load !== null ? Math.max(0.22, load / 100) : 0.25,
            );
          }
        }
      } else if (q.kind === "plugins") {
        activeLayerSet.add("plugins");
        for (const host of net.hosts) {
          const pluginCount = host.plugins.length;
          const blobObjects = host.blobStore?.objects ?? 0;
          if (pluginCount > 0 || blobObjects > 0) {
            const intensity = Math.min(1, 0.45 + pluginCount * 0.2 + (blobObjects > 0 ? 0.15 : 0));
            upsertCell(host, idx, "plugins", H3_LAYER_COLORS.plugins, intensity);
          }
        }
      } else if (q.kind === "users") {
        activeLayerSet.add("users");
        const activeHostNames = new Set<string>();
        for (const user of net.users) {
          for (const loc of user.locations) {
            if (loc.viewingNode) activeHostNames.add(loc.viewingNode);
          }
          for (const sn of user.shellNodes) {
            if (sn) activeHostNames.add(sn);
          }
        }
        for (const host of net.hosts) {
          if (activeHostNames.has(host.name)) {
            upsertCell(host, idx, "users", H3_LAYER_COLORS.users, 0.85);
          }
        }
      } else if (q.kind === "recovery" || q.kind === "tests" || q.kind === "log") {
        activeLayerSet.add("probes");
        const hasFailingTest =
          (q.kind === "tests" || q.kind === "log") &&
          net.tests.some((t) => t.status === "fail");
        for (const host of net.hosts) {
          const fail = isHostProbeFailing(host) || hasFailingTest;
          upsertCell(
            host,
            idx,
            "probes",
            fail ? H3_LAYER_COLORS.probesFail : H3_LAYER_COLORS.probesPass,
            fail ? 0.95 : 0.48,
          );
        }
      }
    }
  }

  const h3Cells = [...cellMap.values()];
  const arcNodes = [...arcNodeMap.values()];
  const onlyMeasuredLinks = !isSimulated;
  const focusHostName =
    hasSingleHostQuery && !hasBroadArcQuery && selectedHostName
      ? selectedHostName
      : null;
  const measuredArcCount = countRenderableArcs(
    arcNodes,
    onlyMeasuredLinks,
    focusHostName,
  );

  const layerOrder: H3LayerKind[] = ["load", "plugins", "users", "probes"];
  const activeLayers = layerOrder.filter((l) => activeLayerSet.has(l));
  const layerLabel = activeLayers.map((l) => l.toUpperCase()).join("+");
  const arcPart =
    arcNodes.length > 0
      ? `ARCS: ${measuredArcCount} ${onlyMeasuredLinks ? "RTT" : "SIM RTT"}`
      : "NO RTT QUERY";
  const legend = `H3: ${layerLabel} (${h3Cells.length}) · ${arcPart}`;

  const legendTooltip = [
    `Active Query Set drives every 3D overlay (exact res-3 H3 tile per node, 0 decorative halos).`,
    `LOAD (hosts/networks): green <40%, amber 40–75%, red ≥75% max(CPU, RAM).`,
    `PLUGINS: cyan tiles on hosts serving verified iroh-blobs plugins.`,
    `USERS: violet tiles on nodes actively viewed or shelled by signed-in users.`,
    `PROBES (tests/recovery/log): green all-pass, red failing.`,
    `ARCS: ${onlyMeasuredLinks ? "measured peer_rtt_ms only" : "simulated RTT"} (<50ms green, 50–120ms cyan, ≥120ms amber).`,
  ].join(" ");

  const signature = [
    onlyMeasuredLinks ? "live" : "sim",
    focusHostName ?? "",
    markers
      .map(
        (m) =>
          `${m.networkSlug}:${m.node.name}:${m.node.lat.toFixed(2)},${m.node.lng.toFixed(2)}:${m.node.online ? 1 : 0}:${nodeLoadPercent(m.node.stats) ?? -1}`,
      )
      .join("|"),
    h3Cells
      .map((c) => `${c.cell}:${c.layer}:${c.colorHex.toString(16)}:${c.intensity.toFixed(2)}`)
      .sort()
      .join("|"),
    arcNodes
      .map(
        (a) =>
          `${a.id}:${a.lat.toFixed(2)},${a.lng.toFixed(2)}:${Object.entries(a.peerRttMs ?? {})
            .sort(([k1], [k2]) => k1.localeCompare(k2))
            .map(([k, v]) => `${k}=${Math.round(v)}`)
            .join(",")}`,
      )
      .join("|"),
  ].join("##");

  return {
    signature,
    markers,
    h3Cells,
    arcNodes,
    onlyMeasuredLinks,
    focusHostName,
    activeLayers,
    measuredArcCount,
    legend,
    legendTooltip,
  };
}

function latLngToVector(lat: number, lng: number, radius: number): THREE.Vector3 {
  const latRad = lat * DEG_TO_RAD;
  const lngRad = -lng * DEG_TO_RAD;
  return new THREE.Vector3(
    Math.cos(latRad) * Math.cos(lngRad),
    Math.sin(latRad),
    Math.cos(latRad) * Math.sin(lngRad),
  ).multiplyScalar(radius);
}

/**
 * Renders query-driven exact H3 res-3 hex tiles on top of the globe using
 * vertex colors driven directly by each cell's real metric color and intensity.
 */
export class GeospatialH3Overlay {
  readonly group = new THREE.Group();
  private readonly fillMesh: THREE.Mesh;
  private readonly fillMaterial: THREE.MeshBasicMaterial;
  private readonly edgeLines: THREE.LineSegments;
  private readonly edgeMaterial: THREE.LineBasicMaterial;

  constructor(cells: H3DataCell[], earthRadius: number) {
    const fillPositions: number[] = [];
    const fillColors: number[] = [];
    const edgePositions: number[] = [];
    const edgeColors: number[] = [];

    const tmpColor = new THREE.Color();

    for (const item of cells) {
      const boundary = cellToBoundary(item.cell, true);
      // Radial elevation proportional to real metric intensity [0..1]
      const lift = 1.0045 + item.intensity * 0.0055;
      const fillRadius = earthRadius * lift;
      const edgeRadius = earthRadius * (lift + 0.0012);

      tmpColor.setHex(item.colorHex);
      const gain = 0.45 + item.intensity * 0.55;
      const r = tmpColor.r * gain;
      const g = tmpColor.g * gain;
      const b = tmpColor.b * gain;

      const ringPts: THREE.Vector3[] = [];
      const edgePts: THREE.Vector3[] = [];
      const center = new THREE.Vector3();

      for (const [lng, lat] of boundary) {
        const p = latLngToVector(lat, lng, fillRadius);
        ringPts.push(p);
        edgePts.push(latLngToVector(lat, lng, edgeRadius));
        center.add(p);
      }
      center.divideScalar(boundary.length).normalize().multiplyScalar(fillRadius);

      for (let i = 0; i < boundary.length; i += 1) {
        const a = ringPts[i];
        const bPt = ringPts[(i + 1) % ringPts.length];
        fillPositions.push(
          center.x, center.y, center.z,
          a.x, a.y, a.z,
          bPt.x, bPt.y, bPt.z,
        );
        fillColors.push(r, g, b, r, g, b, r, g, b);

        const ea = edgePts[i];
        const eb = edgePts[(i + 1) % edgePts.length];
        edgePositions.push(ea.x, ea.y, ea.z, eb.x, eb.y, eb.z);
        edgeColors.push(
          tmpColor.r, tmpColor.g, tmpColor.b,
          tmpColor.r, tmpColor.g, tmpColor.b,
        );
      }
    }

    const fillGeo = new THREE.BufferGeometry();
    fillGeo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(fillPositions, 3),
    );
    fillGeo.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(fillColors, 3),
    );

    this.fillMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.36,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.fillMesh = new THREE.Mesh(fillGeo, this.fillMaterial);
    this.fillMesh.renderOrder = 2;

    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(edgePositions, 3),
    );
    edgeGeo.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(edgeColors, 3),
    );

    this.edgeMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.58,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.edgeLines = new THREE.LineSegments(edgeGeo, this.edgeMaterial);
    this.edgeLines.renderOrder = 3;

    this.group.add(this.fillMesh, this.edgeLines);
  }

  updatePulse(timeSec: number): void {
    const wave = 0.5 + 0.5 * Math.sin(timeSec * 0.9);
    this.fillMaterial.opacity = 0.28 + wave * 0.14;
    this.edgeMaterial.opacity = 0.48 + wave * 0.18;
  }

  dispose(): void {
    this.fillMesh.geometry.dispose();
    this.fillMaterial.dispose();
    this.edgeLines.geometry.dispose();
    this.edgeMaterial.dispose();
  }
}
