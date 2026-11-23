export type Vec3 = [number, number, number];

export interface GeoNodePoint {
  id: string;
  name?: string;
  networkIndex: number;
  lat: number;
  lng: number;
  rttMs?: number | null;
  /** Optional real measured peer-to-peer RTT map (peer name -> ms) */
  peerRttMs?: Record<string, number>;
}

export interface BundledPingEdge {
  fromId: string;
  toId: string;
  networkIndex: number;
  rttMs: number;
  /** Sampled 3D points along the atmospheric bundled arc */
  points: Vec3[];
  /** Normalized cumulative arc length [0..1] per sample point */
  progress: number[];
  /** Animation phase offset [0..1] so pings stagger naturally */
  phase: number;
  /** Speed factor derived from latency (lower RTT -> faster pulse) */
  speed: number;
}

const DEG_TO_RAD = Math.PI / 180;

export function latLngToUnitVec3(lat: number, lng: number): Vec3 {
  const latRad = lat * DEG_TO_RAD;
  const lngRad = -lng * DEG_TO_RAD;
  return [
    Math.cos(latRad) * Math.cos(lngRad),
    Math.sin(latRad),
    Math.cos(latRad) * Math.sin(lngRad),
  ];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function len(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function normalize(v: Vec3): Vec3 {
  const l = len(v);
  if (l < 1e-9) return [0, 1, 0];
  return [v[0] / l, v[1] / l, v[2] / l];
}

function scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function slerp(a: Vec3, b: Vec3, t: number): Vec3 {
  const d = Math.max(-1, Math.min(1, dot(a, b)));
  const omega = Math.acos(d);
  if (omega < 1e-4) {
    return normalize([
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ]);
  }
  const sinOmega = Math.sin(omega);
  const wA = Math.sin((1 - t) * omega) / sinOmega;
  const wB = Math.sin(t * omega) / sinOmega;
  return normalize([
    a[0] * wA + b[0] * wB,
    a[1] * wA + b[1] * wB,
    a[2] * wA + b[2] * wB,
  ]);
}

/**
 * Assign each node to a coarse geographic cluster hub (30°×45° spherical grid)
 * so nearby nodes share a common regional trunk waypoint before curving out
 * across continents — keeping dense networks readable.
 */
function regionalHubKey(lat: number, lng: number): string {
  const latBin = Math.floor((lat + 90) / 28);
  const lngBin = Math.floor((lng + 180) / 42);
  return `${latBin}:${lngBin}`;
}

function evaluateCubicBezier(
  p0: Vec3,
  p1: Vec3,
  p2: Vec3,
  p3: Vec3,
  t: number,
): Vec3 {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;
  return [
    uuu * p0[0] + 3 * uu * t * p1[0] + 3 * u * tt * p2[0] + ttt * p3[0],
    uuu * p0[1] + 3 * uu * t * p1[1] + 3 * u * tt * p2[1] + ttt * p3[1],
    uuu * p0[2] + 3 * uu * t * p1[2] + 3 * u * tt * p2[2] + ttt * p3[2],
  ];
}

function estimateRttMs(uA: Vec3, uB: Vec3, hintA?: number | null, hintB?: number | null): number {
  if (typeof hintA === "number" && hintA > 0 && typeof hintB === "number" && hintB > 0) {
    return Math.round(((hintA + hintB) / 2) * 10) / 10;
  }
  const angle = Math.acos(Math.max(-1, Math.min(1, dot(uA, uB))));
  const km = angle * 6371;
  // Fiber speed-of-light RTT baseline + routing overhead
  return Math.max(4, Math.round((km / 100 + 6) * 10) / 10);
}

/**
 * Builds hierarchically bundled + compatibility-relaxed atmospheric ping arcs.
 *
 * 1. Computes regional hub centroids + per-network trunk centroids.
 * 2. Routes each peer-to-peer edge through hierarchical control points blended
 *    by bundling strength `beta` (Holten hierarchical bundling on S²).
 * 3. Runs 2 lightweight compatibility-weighted force-directed bundling passes
 *    on interior sample points so parallel corridors braid cleanly together.
 * 4. Lifts every bundled sample point into the atmosphere along a smooth sine
 *    altitude envelope proportional to great-circle span.
 */
export function buildBundledPingArcs(
  nodes: GeoNodePoint[],
  earthRadius: number,
  options?: {
    segments?: number;
    beta?: number;
    forceIterations?: number;
    maxPairsPerNetwork?: number;
    /** When true, only draw arcs where a real measured peerRttMs link exists between peers */
    onlyMeasuredLinks?: boolean;
    /** Optional host name filter: only draw arcs incident to this host */
    focusHostName?: string | null;
  },
): BundledPingEdge[] {
  const segments = options?.segments ?? 40;
  const beta = options?.beta ?? 0.72;
  const forceIterations = options?.forceIterations ?? 2;
  const maxPairsPerNetwork = options?.maxPairsPerNetwork ?? 42;
  const onlyMeasuredLinks = options?.onlyMeasuredLinks ?? false;
  const focusHostName = options?.focusHostName ?? null;

  if (nodes.length < 2) return [];

  // 1. Precompute unit vectors, regional hub centroids, and per-network centroids
  const units = new Map<string, Vec3>();
  const regionSums = new Map<string, Vec3>();
  const netSums = new Map<number, Vec3>();

  for (const node of nodes) {
    const u = latLngToUnitVec3(node.lat, node.lng);
    units.set(node.id, u);
    const rk = regionalHubKey(node.lat, node.lng);
    regionSums.set(rk, add(regionSums.get(rk) ?? [0, 0, 0], u));
    netSums.set(node.networkIndex, add(netSums.get(node.networkIndex) ?? [0, 0, 0], u));
  }

  const regionHubs = new Map<string, Vec3>();
  for (const [k, sum] of regionSums.entries()) {
    regionHubs.set(k, normalize(sum));
  }
  const netHubs = new Map<number, Vec3>();
  for (const [k, sum] of netSums.entries()) {
    netHubs.set(k, normalize(sum));
  }

  // 2. Select edges: intra-network mesh + inter-cluster backbone trunks
  const byNet = new Map<number, GeoNodePoint[]>();
  for (const node of nodes) {
    const list = byNet.get(node.networkIndex) ?? [];
    list.push(node);
    byNet.set(node.networkIndex, list);
  }

  type RawPair = {
    a: GeoNodePoint;
    b: GeoNodePoint;
    networkIndex: number;
    measuredRttMs: number | null;
  };
  const rawPairs: RawPair[] = [];

  const lookupMeasuredRtt = (a: GeoNodePoint, b: GeoNodePoint): number | null => {
    const aName = a.name || a.id.split(":").pop() || a.id;
    const bName = b.name || b.id.split(":").pop() || b.id;
    const ab = a.peerRttMs?.[bName];
    const ba = b.peerRttMs?.[aName];
    if (typeof ab === "number" && typeof ba === "number") return Math.round(((ab + ba) / 2) * 10) / 10;
    if (typeof ab === "number") return ab;
    if (typeof ba === "number") return ba;
    return null;
  };

  for (const [netIdx, netNodes] of byNet.entries()) {
    let added = 0;
    for (let i = 0; i < netNodes.length; i += 1) {
      for (let j = i + 1; j < netNodes.length; j += 1) {
        if (added >= maxPairsPerNetwork) break;
        const na = netNodes[i];
        const nb = netNodes[j];
        if (focusHostName) {
          const aName = na.name || na.id.split(":").pop() || na.id;
          const bName = nb.name || nb.id.split(":").pop() || nb.id;
          if (aName !== focusHostName && bName !== focusHostName) continue;
        }
        const uA = units.get(na.id)!;
        const uB = units.get(nb.id)!;
        const angle = Math.acos(Math.max(-1, Math.min(1, dot(uA, uB))));
        if (angle < 0.004) continue;
        const measured = lookupMeasuredRtt(na, nb);
        if (onlyMeasuredLinks && measured === null) continue;
        rawPairs.push({ a: na, b: nb, networkIndex: netIdx, measuredRttMs: measured });
        added += 1;
      }
    }
  }

  if (rawPairs.length === 0) return [];

  // 3. Initial hierarchical spherical splines on unit sphere S²
  type DraftEdge = {
    a: GeoNodePoint;
    b: GeoNodePoint;
    networkIndex: number;
    angle: number;
    rttMs: number;
    unitPts: Vec3[];
    dir: Vec3;
    mid: Vec3;
  };

  const drafts: DraftEdge[] = rawPairs.map(({ a, b, networkIndex, measuredRttMs }) => {
    const uA = units.get(a.id)!;
    const uB = units.get(b.id)!;
    const angle = Math.acos(Math.max(-1, Math.min(1, dot(uA, uB))));
    const hubA = regionHubs.get(regionalHubKey(a.lat, a.lng)) ?? uA;
    const hubB = regionHubs.get(regionalHubKey(b.lat, b.lng)) ?? uB;
    const netHub = netHubs.get(networkIndex) ?? slerp(uA, uB, 0.5);

    // Control points pulled toward regional & network trunk hubs by `beta`
    const unbundled1 = slerp(uA, uB, 0.32);
    const unbundled2 = slerp(uA, uB, 0.68);
    const trunk1 = slerp(hubA, netHub, 0.45);
    const trunk2 = slerp(hubB, netHub, 0.45);
    const c1 = slerp(unbundled1, trunk1, beta);
    const c2 = slerp(unbundled2, trunk2, beta);

    const unitPts: Vec3[] = [];
    for (let s = 0; s <= segments; s += 1) {
      const t = s / segments;
      unitPts.push(normalize(evaluateCubicBezier(uA, c1, c2, uB, t)));
    }

    const chord = sub(uB, uA);
    return {
      a,
      b,
      networkIndex,
      angle,
      rttMs: measuredRttMs ?? estimateRttMs(uA, uB, a.rttMs, b.rttMs),
      unitPts,
      dir: normalize(chord),
      mid: slerp(uA, uB, 0.5),
    };
  });

  // 4. Lightweight compatibility-weighted Force-Directed Edge Bundling (FDEB)
  //    on interior points so nearby corridors braid into clean atmospheric trunks
  const pullStrength = 0.24;
  for (let iter = 0; iter < forceIterations; iter += 1) {
    const nextSamples = drafts.map((d) => d.unitPts.map((p) => [...p] as Vec3));
    for (let i = 0; i < drafts.length; i += 1) {
      const ei = drafts[i];
      for (let s = 1; s < segments; s += 1) {
        let sumX = 0;
        let sumY = 0;
        let sumZ = 0;
        let weightSum = 0;
        const pi = ei.unitPts[s];
        const taper = Math.sin((Math.PI * s) / segments);

        for (let j = 0; j < drafts.length; j += 1) {
          if (i === j) continue;
          const ej = drafts[j];
          // Angle + proximity compatibility
          const align = Math.abs(dot(ei.dir, ej.dir));
          if (align < 0.55) continue;
          const midDot = dot(ei.mid, ej.mid);
          if (midDot < 0.35) continue;

          // Match direction orientation when pulling sample s
          const sameDir = dot(ei.dir, ej.dir) >= 0;
          const pj = ej.unitPts[sameDir ? s : segments - s];
          const compat = align * midDot;
          sumX += (pj[0] - pi[0]) * compat;
          sumY += (pj[1] - pi[1]) * compat;
          sumZ += (pj[2] - pi[2]) * compat;
          weightSum += compat;
        }

        if (weightSum > 0) {
          const factor = (pullStrength * taper) / (1 + weightSum * 0.5);
          nextSamples[i][s] = normalize([
            pi[0] + (sumX / weightSum) * factor,
            pi[1] + (sumY / weightSum) * factor,
            pi[2] + (sumZ / weightSum) * factor,
          ]);
        }
      }
    }
    for (let i = 0; i < drafts.length; i += 1) {
      drafts[i].unitPts = nextSamples[i];
    }
  }

  // 5. Lift bundled curves smoothly into the atmosphere above the globe
  return drafts.map((d, idx) => {
    // Atmospheric apex height scales gracefully with geodesic span:
    // regional hops rise ~8% above radius; global transoceanic arcs arch ~30% high
    const spanRatio = Math.min(1, d.angle / Math.PI);
    const apexLift = 0.08 + 0.24 * Math.pow(spanRatio, 0.8);

    const points: Vec3[] = [];
    const progress: number[] = [];
    let totalLen = 0;

    for (let s = 0; s <= segments; s += 1) {
      const t = s / segments;
      const arch = Math.pow(Math.sin(Math.PI * t), 0.85);
      const radius = earthRadius * (1.012 + apexLift * arch);
      const pt = scale(d.unitPts[s], radius);
      if (s > 0) {
        totalLen += len(sub(pt, points[s - 1]));
      }
      points.push(pt);
      progress.push(totalLen);
    }

    const normProgress =
      totalLen > 1e-6
        ? progress.map((v) => v / totalLen)
        : progress.map((_, s) => s / segments);

    // Deterministic golden-ratio phase stagger so pings cascade smoothly
    const phase = ((idx * 0.61803398875) % 1 + 1) % 1;
    // Lower RTT -> crisper, faster ping pulse; higher RTT -> slower transoceanic sweep
    const speed = Math.max(0.16, Math.min(0.45, 16 / (d.rttMs + 28)));

    return {
      fromId: d.a.id,
      toId: d.b.id,
      networkIndex: d.networkIndex,
      rttMs: d.rttMs,
      points,
      progress: normProgress,
      phase,
      speed,
    };
  });
}
