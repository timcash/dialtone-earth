import { cellToBoundary, gridDisk, latLngToCell } from "h3-js";
import * as THREE from "three";
import type { GeoNodePoint } from "./edge-bundling";

const DEG_TO_RAD = Math.PI / 180;

export interface SimulatedH3Region {
  id: string;
  label: string;
  lat: number;
  lng: number;
  networkIndex: number;
  intensity: number;
  ringSize: number;
}

/**
 * Simulated geospatial H3 telemetry corridors & relay clusters on top of the
 * globe so the logged-out tour demonstrates regional H3 activity + dense
 * bundled latency lines across continents.
 */
export const SIMULATED_GEOSPATIAL_CLUSTERS: SimulatedH3Region[] = [
  // North America West & Central
  { id: "geo-sfo", label: "US-West", lat: 37.77, lng: -122.42, networkIndex: 0, intensity: 0.92, ringSize: 2 },
  { id: "geo-sea", label: "US-NW", lat: 47.61, lng: -122.33, networkIndex: 0, intensity: 0.68, ringSize: 1 },
  { id: "geo-den", label: "US-Mountain", lat: 39.74, lng: -104.99, networkIndex: 1, intensity: 0.74, ringSize: 1 },
  { id: "geo-aus", label: "US-South", lat: 30.27, lng: -97.74, networkIndex: 0, intensity: 0.81, ringSize: 2 },
  // North America East
  { id: "geo-nyc", label: "US-East", lat: 40.71, lng: -74.01, networkIndex: 1, intensity: 0.95, ringSize: 2 },
  { id: "geo-iad", label: "US-VA", lat: 38.9, lng: -77.04, networkIndex: 0, intensity: 0.85, ringSize: 1 },
  // Europe
  { id: "geo-lon", label: "EU-West", lat: 51.51, lng: -0.13, networkIndex: 0, intensity: 0.88, ringSize: 2 },
  { id: "geo-fra", label: "EU-Central", lat: 50.11, lng: 8.68, networkIndex: 1, intensity: 0.94, ringSize: 2 },
  { id: "geo-sto", label: "EU-North", lat: 59.33, lng: 18.07, networkIndex: 2, intensity: 0.72, ringSize: 1 },
  { id: "geo-mad", label: "EU-South", lat: 40.42, lng: -3.7, networkIndex: 1, intensity: 0.65, ringSize: 1 },
  // Asia-Pacific
  { id: "geo-tyo", label: "AP-East", lat: 35.68, lng: 139.65, networkIndex: 2, intensity: 0.93, ringSize: 2 },
  { id: "geo-sin", label: "AP-SE", lat: 1.35, lng: 103.82, networkIndex: 2, intensity: 0.86, ringSize: 2 },
  { id: "geo-syd", label: "AP-South", lat: -33.87, lng: 151.21, networkIndex: 2, intensity: 0.7, ringSize: 1 },
  // South America
  { id: "geo-gru", label: "SA-East", lat: -23.55, lng: -46.63, networkIndex: 1, intensity: 0.76, ringSize: 1 },
];

export interface H3DataCell {
  cell: string;
  intensity: number;
  networkIndex: number;
}

/**
 * Generates deduplicated H3 resolution-3 geospatial telemetry cells around
 * active nodes and regional clusters.
 */
export function buildSimulatedH3DataCells(
  nodes: GeoNodePoint[],
  resolution = 3,
  includeSimulatedClusters = true,
): H3DataCell[] {
  const map = new Map<string, H3DataCell>();

  const seedCell = (
    lat: number,
    lng: number,
    networkIndex: number,
    baseIntensity: number,
    ringSize: number,
  ) => {
    const center = latLngToCell(lat, lng, resolution);
    const disk = gridDisk(center, ringSize);
    disk.forEach((cell, idx) => {
      // Smooth radial falloff from center cell (idx 0) to outer ring
      const falloff = idx === 0 ? 1.0 : idx <= 6 ? 0.62 : 0.34;
      const intensity = Math.min(1, baseIntensity * falloff);
      const existing = map.get(cell);
      if (!existing || intensity > existing.intensity) {
        map.set(cell, { cell, intensity, networkIndex });
      }
    });
  };

  for (const node of nodes) {
    seedCell(node.lat, node.lng, node.networkIndex, 0.95, 1);
  }
  if (includeSimulatedClusters) {
    for (const cluster of SIMULATED_GEOSPATIAL_CLUSTERS) {
      seedCell(
        cluster.lat,
        cluster.lng,
        cluster.networkIndex,
        cluster.intensity,
        cluster.ringSize,
      );
    }
  }

  return [...map.values()];
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
 * Renders the simulated geospatial H3 hex heatmap tiles on top of the globe
 * using vertex colors (single draw call for fills + single draw call for crisp
 * outlines, zero runtime geometry overhead).
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

    const colorLow = new THREE.Color(0x1f8f6b);
    const colorMid = new THREE.Color(0x36d66b);
    const colorHigh = new THREE.Color(0x66f2ff);
    const tmpColor = new THREE.Color();

    for (const item of cells) {
      const boundary = cellToBoundary(item.cell, true);
      // Slight radial elevation proportional to simulated geospatial intensity
      const lift = 1.0045 + item.intensity * 0.0055;
      const fillRadius = earthRadius * lift;
      const edgeRadius = earthRadius * (lift + 0.0012);

      if (item.intensity < 0.55) {
        tmpColor.copy(colorLow).lerp(colorMid, item.intensity / 0.55);
      } else {
        tmpColor.copy(colorMid).lerp(colorHigh, (item.intensity - 0.55) / 0.45);
      }
      // Attenuate brightness by intensity so outer ring cells gently blend into globe
      const gain = 0.35 + item.intensity * 0.65;
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
      opacity: 0.34,
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
      opacity: 0.48,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.edgeLines = new THREE.LineSegments(edgeGeo, this.edgeMaterial);
    this.edgeLines.renderOrder = 3;

    this.group.add(this.fillMesh, this.edgeLines);
  }

  updatePulse(timeSec: number): void {
    const wave = 0.5 + 0.5 * Math.sin(timeSec * 0.9);
    this.fillMaterial.opacity = 0.26 + wave * 0.14;
    this.edgeMaterial.opacity = 0.38 + wave * 0.18;
  }

  dispose(): void {
    this.fillMesh.geometry.dispose();
    this.fillMaterial.dispose();
    this.edgeLines.geometry.dispose();
    this.edgeMaterial.dispose();
  }
}
