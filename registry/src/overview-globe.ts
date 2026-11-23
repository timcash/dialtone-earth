import { latLngToCell } from "h3-js";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  buildBundledPingArcs,
  type GeoNodePoint,
} from "./edge-bundling";
import {
  buildSimulatedH3DataCells,
  GeospatialH3Overlay,
  SIMULATED_GEOSPATIAL_CLUSTERS,
} from "./h3-geodata";
import { HexLayer } from "./hex-layer";
import {
  createHudAtmosphereMaterial,
  createHudCloudMaterial,
  createHudOutlineMaterial,
} from "./hud-globe-materials";
import {
  NODE_DOT_RADIUS_RATIO,
  nodeLoadColor,
} from "./node-load";
import type { NetworkNode, OverviewNetwork } from "./types";

const EARTH_RADIUS = 50;
const DEG_TO_RAD = Math.PI / 180;
const HUD_GLOBE_DISTANCE = EARTH_RADIUS * (9.2 / 2.8);
const NETWORK_DISTANCE = HUD_GLOBE_DISTANCE;
const NODE_DISTANCE = HUD_GLOBE_DISTANCE;
const TRANSITION_MS = 1_800;
const DWELL_MS = 2_600;
const RESUME_DELAY_MS = 5_000;
const NODE_DOT_RADIUS = EARTH_RADIUS * NODE_DOT_RADIUS_RATIO;
const NODE_RING_RADIUS = EARTH_RADIUS * (0.1 / 2.8);

type LandPayload = {
  cells: string[];
};

type TourStop = {
  networkIndex: number;
  nodeIndex: number | null;
  rotation: THREE.Quaternion;
  distance: number;
};

type MarkerVisual = {
  networkIndex: number;
  nodeIndex: number;
  mesh: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  ring: THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  baseColor: THREE.Color;
  active: boolean;
};

type ArcVisual = {
  networkIndex: number;
  material: THREE.ShaderMaterial;
  baseOpacity: number;
};

export type OverviewGlobeOptions = {
  includeSimulatedGeodata?: boolean;
};

export type OverviewGlobeController = {
  dispose: () => void;
  focusTarget: (networkSlug: string | null, nodeName?: string | null) => void;
};

export async function mountOverviewGlobe(
  container: HTMLElement,
  networks: OverviewNetwork[],
  onFocus: (networkSlug: string) => void,
  options: OverviewGlobeOptions = {},
): Promise<OverviewGlobeController> {
  const landCells = await loadLandCells();
  const globe = new OverviewGlobe(
    container,
    networks,
    landCells,
    onFocus,
    options.includeSimulatedGeodata ?? true,
  );
  return {
    dispose: () => globe.dispose(),
    focusTarget: (networkSlug, nodeName) =>
      globe.focusTarget(networkSlug, nodeName ?? null),
  };
}

async function loadLandCells(): Promise<string[]> {
  try {
    const response = await fetch("/land.h3.json", {
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      const payload = (await response.json()) as LandPayload | string[];
      const cells = Array.isArray(payload) ? payload : payload.cells;
      if (Array.isArray(cells) && cells.length > 0) return cells;
    }
  } catch {
    // Fall through to a coarse H3 shell.
  }

  const cells = new Set<string>();
  for (let lat = -80; lat <= 80; lat += 10) {
    for (let lng = -180; lng < 180; lng += 10) {
      cells.add(latLngToCell(lat, lng, 3));
    }
  }
  return [...cells];
}

class OverviewGlobe {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(34, 1, 0.05, 1000);
  private readonly renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  private readonly controls: OrbitControls;
  private readonly globe = new THREE.Group();
  private readonly hexLayer: HexLayer;
  private readonly geoOverlay: GeospatialH3Overlay;
  private readonly markers: MarkerVisual[] = [];
  private readonly arcs: ArcVisual[] = [];
  private readonly stops: TourStop[] = [];
  private readonly resizeObserver: ResizeObserver;
  private limbMaterial!: THREE.ShaderMaterial;
  private cloudMaterial!: THREE.ShaderMaterial;
  private readonly reducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  private frameId = 0;
  private currentStopIndex = 0;
  private targetStopIndex = 0;
  private resumeStopIndex = 0;
  private phase: "dwell" | "transition" = "dwell";
  private phaseStarted = performance.now();
  private transitionFromDirection = new THREE.Vector3(0, 0, 1);
  private transitionFromDistance = NETWORK_DISTANCE;
  private transitionFromGlobeRotation = new THREE.Quaternion();
  private interrupted = false;
  private resumeAt = Number.POSITIVE_INFINITY;

  constructor(
    private readonly container: HTMLElement,
    private readonly networks: OverviewNetwork[],
    landCells: string[],
    private readonly onFocus: (networkSlug: string) => void,
    includeSimulatedGeodata: boolean,
  ) {
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.setAttribute(
      "aria-label",
      "Interactive H3 Earth globe",
    );
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.055;
    this.controls.enablePan = false;
    this.controls.minDistance = 118;
    this.controls.maxDistance = 260;
    this.controls.rotateSpeed = 0.42;
    this.controls.zoomSpeed = 0.68;
    this.controls.addEventListener("start", this.handleControlStart);
    this.controls.addEventListener("end", this.handleControlEnd);

    this.scene.add(this.globe);
    this.addEarth();
    this.hexLayer = new HexLayer(landCells, EARTH_RADIUS);
    this.globe.add(this.hexLayer.group);

    const allGeoPoints: GeoNodePoint[] = [];
    networks.forEach((network, networkIndex) => {
      network.snapshot.nodes.forEach((node, nodeIndex) => {
        this.addNode(node, networkIndex, nodeIndex);
        allGeoPoints.push({
          id: `${network.slug}:${node.name}`,
          networkIndex,
          lat: node.lat,
          lng: node.lng,
          rttMs: node.rtt_ms ?? null,
        });
      });
    });

    if (includeSimulatedGeodata) {
      SIMULATED_GEOSPATIAL_CLUSTERS.forEach((cluster) => {
        this.addRelayMicroNode(cluster.lat, cluster.lng);
        allGeoPoints.push({
          id: cluster.id,
          networkIndex: cluster.networkIndex % Math.max(1, networks.length),
          lat: cluster.lat,
          lng: cluster.lng,
          rttMs: null,
        });
      });
    }

    const h3Cells = buildSimulatedH3DataCells(allGeoPoints, 3);
    this.geoOverlay = new GeospatialH3Overlay(h3Cells, EARTH_RADIUS);
    this.globe.add(this.geoOverlay.group);

    this.addBundledPingArcs(allGeoPoints);
    this.buildTour();

    if (this.stops.length > 0) {
      const first = this.stops[0];
      this.camera.position.set(0, 0, first.distance);
      this.globe.quaternion.copy(first.rotation);
      this.applyFocus(first);
    } else {
      this.camera.position.set(0, 0, NETWORK_DISTANCE);
    }
    this.camera.lookAt(0, 0, 0);
    this.controls.target.set(0, 0, 0);
    this.controls.update();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.animate();
  }

  focusTarget(networkSlug: string | null, nodeName: string | null): void {
    if (this.stops.length === 0) return;
    if (!networkSlug) {
      this.interrupted = false;
      this.beginTransition(0, performance.now());
      return;
    }
    const networkIndex = this.networks.findIndex(
      (item) => item.slug === networkSlug,
    );
    if (networkIndex < 0) return;
    const nodeIndex = nodeName
      ? this.networks[networkIndex].snapshot.nodes.findIndex(
          (node) => node.name === nodeName,
        )
      : -1;
    const stopIndex = this.stops.findIndex(
      (stop) =>
        stop.networkIndex === networkIndex &&
        stop.nodeIndex === (nodeIndex >= 0 ? nodeIndex : null),
    );
    if (stopIndex >= 0) {
      this.interrupted = false;
      this.beginTransition(stopIndex, performance.now());
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.frameId);
    this.resizeObserver.disconnect();
    this.controls.removeEventListener("start", this.handleControlStart);
    this.controls.removeEventListener("end", this.handleControlEnd);
    this.controls.dispose();
    this.hexLayer.dispose();
    this.geoOverlay.dispose();
    this.scene.traverse((object) => {
      if (
        !(
          object instanceof THREE.Mesh ||
          object instanceof THREE.Points ||
          object instanceof THREE.Line
        )
      ) {
        return;
      }
      object.geometry.dispose();
      const materials = Array.isArray(object.material)
        ? object.material
        : [object.material];
      materials.forEach((material) => material.dispose());
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private addEarth(): void {
    const sphereGeometry = new THREE.SphereGeometry(
      EARTH_RADIUS,
      48,
      36,
    );
    const earth = new THREE.Mesh(
      sphereGeometry,
      new THREE.MeshBasicMaterial({
        colorWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      }),
    );
    this.globe.add(earth);

    this.limbMaterial = createHudOutlineMaterial(1.6);
    const limb = new THREE.Mesh(sphereGeometry, this.limbMaterial);
    limb.scale.setScalar(1.002);
    this.globe.add(limb);

    const graticule = new THREE.LineSegments(
      createGraticuleGeometry(EARTH_RADIUS * 1.002),
      new THREE.LineBasicMaterial({
        color: 0x474747,
        transparent: true,
        opacity: 0.42,
      }),
    );
    this.globe.add(graticule);

    this.cloudMaterial = createHudCloudMaterial();
    const clouds = new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_RADIUS * 1.028, 40, 28),
      this.cloudMaterial,
    );
    this.globe.add(clouds);

    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_RADIUS * 1.055, 40, 28),
      createHudAtmosphereMaterial(),
    );
    this.globe.add(atmosphere);
  }

  private addRelayMicroNode(lat: number, lng: number): void {
    const direction = latLngToVector(lat, lng, 1);
    const position = direction
      .clone()
      .multiplyScalar(EARTH_RADIUS * 1.011);
    const mesh = new THREE.Mesh(
      new THREE.CircleGeometry(NODE_DOT_RADIUS * 0.52, 12),
      new THREE.MeshBasicMaterial({
        color: 0x66f2ff,
        transparent: true,
        opacity: 0.72,
        side: THREE.DoubleSide,
      }),
    );
    mesh.position.copy(position);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction);
    mesh.renderOrder = 4;
    this.globe.add(mesh);
  }

  private addBundledPingArcs(geoPoints: GeoNodePoint[]): void {
    const bundled = buildBundledPingArcs(geoPoints, EARTH_RADIUS, {
      segments: 44,
      beta: 0.74,
      forceIterations: 2,
      maxPairsPerNetwork: 34,
    });

    bundled.forEach((edge) => {
      const positions = new Float32Array(edge.points.length * 3);
      const progress = new Float32Array(edge.progress.length);
      for (let i = 0; i < edge.points.length; i += 1) {
        positions[i * 3] = edge.points[i][0];
        positions[i * 3 + 1] = edge.points[i][1];
        positions[i * 3 + 2] = edge.points[i][2];
        progress[i] = edge.progress[i];
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute("aProgress", new THREE.BufferAttribute(progress, 1));

      const colorHex =
        edge.rttMs < 35
          ? 0x4ef5b8
          : edge.rttMs < 85
            ? 0x56d4ff
            : 0xffc966;

      const material = createBundledPingArcMaterial(
        colorHex,
        edge.phase,
        edge.speed,
      );
      const line = new THREE.Line(geometry, material);
      line.renderOrder = 4;
      this.arcs.push({
        networkIndex: edge.networkIndex,
        material,
        baseOpacity: 0.9,
      });
      this.globe.add(line);
    });
  }

  private addNode(
    node: NetworkNode,
    networkIndex: number,
    nodeIndex: number,
  ): void {
    const color = nodeLoadColor(node.stats);
    const direction = latLngToVector(node.lat, node.lng, 1);
    const position = direction
      .clone()
      .multiplyScalar(EARTH_RADIUS * 1.012);
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: node.online ? 1 : 0.45,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(
      new THREE.CircleGeometry(NODE_DOT_RADIUS, 20),
      material,
    );
    mesh.position.copy(position);
    mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      direction,
    );
    mesh.renderOrder = 5;

    const ringMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.35,
    });
    const ring = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(
        circlePoints(NODE_RING_RADIUS, 40),
      ),
      ringMaterial,
    );
    ring.position.copy(
      direction.clone().multiplyScalar(EARTH_RADIUS * 1.013),
    );
    ring.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      direction,
    );
    ring.visible = false;
    ring.renderOrder = 6;

    this.markers.push({
      networkIndex,
      nodeIndex,
      mesh,
      ring,
      baseColor: new THREE.Color(color),
      active: false,
    });
    this.globe.add(mesh, ring);
  }

  private buildTour(): void {
    this.networks.forEach((network, networkIndex) => {
      const directions = network.snapshot.nodes.map((node) =>
        latLngToVector(node.lat, node.lng, 1),
      );
      const networkDirection = directions
        .reduce(
          (result, direction) => result.add(direction),
          new THREE.Vector3(),
        )
        .normalize();
      this.stops.push({
        networkIndex,
        nodeIndex: null,
        rotation: targetQuaternionForDirection(
          networkDirection.lengthSq() > 0
            ? networkDirection
            : new THREE.Vector3(0, 0, 1),
        ),
        distance: NETWORK_DISTANCE,
      });
      directions.forEach((direction, nodeIndex) => {
        this.stops.push({
          networkIndex,
          nodeIndex,
          rotation: targetQuaternionForDirection(direction),
          distance: NODE_DISTANCE,
        });
      });
    });
  }

  private applyFocus(stop: TourStop): void {
    const network = this.networks[stop.networkIndex];
    if (!network) return;
    const activeNode =
      stop.nodeIndex === null
        ? null
        : network.snapshot.nodes[stop.nodeIndex];
    this.renderer.domElement.dataset.tourStop = activeNode
      ? `${network.slug}/${activeNode.name}`
      : `${network.slug}/overview`;
    this.onFocus(network.slug);

    this.markers.forEach((marker) => {
      marker.active =
        marker.networkIndex === stop.networkIndex &&
        marker.nodeIndex === stop.nodeIndex;
      marker.ring.visible = marker.active;
      marker.mesh.material.color.copy(
        marker.baseColor,
      );
    });
    this.arcs.forEach((arc) => {
      arc.material.uniforms.uFocusGain.value =
        arc.networkIndex === stop.networkIndex ? 1.0 : 0.42;
    });
  }

  private beginTransition(stopIndex: number, now: number): void {
    if (this.stops.length === 0) return;
    this.targetStopIndex = stopIndex % this.stops.length;
    this.transitionFromDirection
      .copy(this.camera.position)
      .normalize();
    this.transitionFromDistance = this.camera.position.length();
    this.transitionFromGlobeRotation.copy(this.globe.quaternion);
    this.phase = "transition";
    this.phaseStarted = now;
    this.applyFocus(this.stops[this.targetStopIndex]);
  }

  private updateTour(now: number): void {
    if (this.stops.length < 2 || this.reducedMotion) return;

    if (this.interrupted) {
      if (now < this.resumeAt) return;
      this.interrupted = false;
      this.beginTransition(this.resumeStopIndex, now);
      return;
    }

    if (this.phase === "dwell") {
      if (now - this.phaseStarted >= DWELL_MS) {
        this.beginTransition(
          (this.currentStopIndex + 1) % this.stops.length,
          now,
        );
      }
      return;
    }

    const progress = Math.min(
      1,
      (now - this.phaseStarted) / TRANSITION_MS,
    );
    const eased = easeInOutCubic(progress);
    const target = this.stops[this.targetStopIndex];
    const cameraRotation = new THREE.Quaternion().setFromUnitVectors(
      this.transitionFromDirection,
      new THREE.Vector3(0, 0, 1),
    );
    const partial = new THREE.Quaternion().slerpQuaternions(
      new THREE.Quaternion(),
      cameraRotation,
      eased,
    );
    const direction = this.transitionFromDirection
      .clone()
      .applyQuaternion(partial)
      .normalize();
    const distance = THREE.MathUtils.lerp(
      this.transitionFromDistance,
      target.distance,
      eased,
    );
    this.camera.position.copy(direction).multiplyScalar(distance);
    this.camera.lookAt(0, 0, 0);
    this.globe.quaternion.slerpQuaternions(
      this.transitionFromGlobeRotation,
      target.rotation,
      eased,
    );

    if (progress >= 1) {
      this.currentStopIndex = this.targetStopIndex;
      this.phase = "dwell";
      this.phaseStarted = now;
    }
  }

  private handleControlStart = (): void => {
    if (this.reducedMotion || this.stops.length < 2) return;
    this.interrupted = true;
    this.resumeAt = Number.POSITIVE_INFINITY;
    this.resumeStopIndex =
      this.phase === "transition"
        ? this.targetStopIndex
        : (this.currentStopIndex + 1) % this.stops.length;
  };

  private handleControlEnd = (): void => {
    if (!this.interrupted) return;
    this.resumeAt = performance.now() + RESUME_DELAY_MS;
  };

  private resize(): void {
    const width = Math.max(this.container.clientWidth, 1);
    const height = Math.max(this.container.clientHeight, 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.limbMaterial.uniforms.uResolution.value.set(width, height);
  }

  private animate = (): void => {
    this.frameId = requestAnimationFrame(this.animate);
    const now = performance.now();
    this.updateTour(now);
    if (this.stops.length === 0 && !this.reducedMotion && !this.interrupted) {
      this.globe.rotation.y += 0.0007;
    }
    const timeSec = now / 1000;
    this.cloudMaterial.uniforms.uTime.value = timeSec;
    this.geoOverlay.updatePulse(timeSec);
    if (!this.reducedMotion) {
      for (let i = 0; i < this.arcs.length; i += 1) {
        this.arcs[i].material.uniforms.uTime.value = timeSec;
      }
    }
    const pulse = 1.3 + Math.sin(now * 0.006) * 0.04;
    this.markers.forEach((marker) => {
      marker.mesh.scale.setScalar(marker.active ? pulse : 1);
      const progress = this.reducedMotion
        ? 0.5
        : (now * 0.00055 + marker.nodeIndex * 0.33) % 1;
      const scale = marker.active
        ? 0.75 + progress * 0.65
        : 0.75 + progress * 0.4;
      marker.ring.scale.setScalar(scale);
      marker.ring.material.opacity =
        (1 - progress) * (marker.active ? 0.75 : 0.35);
    });
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };
}

function createBundledPingArcMaterial(
  colorHex: number,
  phase: number,
  speed: number,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uPhase: { value: phase },
      uSpeed: { value: speed },
      uColor: { value: new THREE.Color(colorHex) },
      uFocusGain: { value: 1.0 },
    },
    vertexShader: /* glsl */ `
      attribute float aProgress;
      varying float vProgress;
      void main() {
        vProgress = aProgress;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uPhase;
      uniform float uSpeed;
      uniform vec3 uColor;
      uniform float uFocusGain;
      varying float vProgress;

      void main() {
        // Soft atmospheric fade at both ground endpoints
        float envelope = sin(clamp(vProgress, 0.0, 1.0) * 3.14159265);
        envelope = pow(max(envelope, 0.0), 0.7);

        // Forward ping comet with smooth fading tail
        float headFwd = fract(uTime * uSpeed + uPhase);
        float distFwd = mod(headFwd - vProgress + 1.0, 1.0);
        float pingFwd = exp(-distFwd * 8.0);

        // Subtle return pong echo
        float headBack = fract(uTime * uSpeed * 0.85 + uPhase + 0.5);
        float distBack = mod(vProgress - headBack + 1.0, 1.0);
        float pingBack = 0.55 * exp(-distBack * 10.5);

        float strand = 0.16 * envelope;
        float pulse = (pingFwd + pingBack) * envelope;
        float alpha = clamp((strand + pulse * 0.92) * uFocusGain, 0.0, 0.95);

        // Brighten ping head subtly toward white for crisp atmospheric sparkle
        vec3 col = mix(uColor, vec3(1.0), clamp(pingFwd * 0.65, 0.0, 0.7));
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
}

function latLngToVector(
  lat: number,
  lng: number,
  radius: number,
): THREE.Vector3 {
  const latRad = lat * DEG_TO_RAD;
  const lngRad = -lng * DEG_TO_RAD;
  return new THREE.Vector3(
    Math.cos(latRad) * Math.cos(lngRad),
    Math.sin(latRad),
    Math.cos(latRad) * Math.sin(lngRad),
  ).multiplyScalar(radius);
}

// Ported from the HUD's north-up overhead geospatial orientation.
function targetQuaternionForDirection(
  siteDirection: THREE.Vector3,
): THREE.Quaternion {
  const siteNormal = siteDirection.clone().normalize();
  let east = new THREE.Vector3(0, 1, 0).cross(siteNormal);
  if (east.lengthSq() < 0.0001) {
    east = new THREE.Vector3(1, 0, 0);
  }
  east.normalize();
  const north = siteNormal.clone().cross(east).normalize();
  const basis = new THREE.Matrix4()
    .makeBasis(east, north, siteNormal)
    .invert();
  return new THREE.Quaternion().setFromRotationMatrix(basis);
}

function createGraticuleGeometry(radius: number): THREE.BufferGeometry {
  const positions: number[] = [];
  for (let lat = -75; lat <= 75; lat += 15) {
    for (let lng = -180; lng < 180; lng += 4) {
      const a = latLngToVector(lat, lng, radius);
      const b = latLngToVector(lat, lng + 4, radius);
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }
  for (let lng = -180; lng < 180; lng += 15) {
    for (let lat = -75; lat < 75; lat += 4) {
      const a = latLngToVector(lat, lng, radius);
      const b = latLngToVector(Math.min(75, lat + 4), lng, radius);
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  return geometry;
}

function circlePoints(radius: number, segments: number): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  for (let index = 0; index < segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    points.push(
      new THREE.Vector3(
        Math.cos(angle) * radius,
        Math.sin(angle) * radius,
        0,
      ),
    );
  }
  return points;
}

function easeInOutCubic(value: number): number {
  return value < 0.5
    ? 4 * value * value * value
    : 1 - Math.pow(-2 * value + 2, 3) / 2;
}
