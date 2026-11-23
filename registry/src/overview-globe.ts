import { latLngToCell } from "h3-js";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { CameraTarget } from "./camera-policy";
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
const DEFAULT_CAMERA_DISTANCE = EARTH_RADIUS * (9.2 / 2.8);
const TRANSITION_MS = 1_400;
const NODE_DOT_RADIUS = EARTH_RADIUS * NODE_DOT_RADIUS_RATIO;
const NODE_RING_RADIUS = EARTH_RADIUS * (0.12 / 2.8);

type LandPayload = {
  cells: string[];
};

type MarkerVisual = {
  networkSlug: string;
  nodeName: string;
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
};

export type OverviewGlobeOptions = {
  includeSimulatedGeodata?: boolean;
};

export type OverviewGlobeController = {
  dispose: () => void;
  setCameraTarget: (target: CameraTarget | null) => void;
};

export async function mountOverviewGlobe(
  container: HTMLElement,
  networks: OverviewNetwork[],
  options: OverviewGlobeOptions = {},
): Promise<OverviewGlobeController> {
  const landCells = await loadLandCells();
  const globe = new OverviewGlobe(
    container,
    networks,
    landCells,
    options.includeSimulatedGeodata ?? true,
  );
  return {
    dispose: () => globe.dispose(),
    setCameraTarget: (target) => globe.setCameraTarget(target),
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
  private readonly targetReticle: THREE.LineLoop<
    THREE.BufferGeometry,
    THREE.LineBasicMaterial
  >;
  private readonly resizeObserver: ResizeObserver;
  private limbMaterial!: THREE.ShaderMaterial;
  private cloudMaterial!: THREE.ShaderMaterial;
  private readonly reducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  private frameId = 0;
  private userDragging = false;
  private transitioning = false;
  private transitionStart = 0;
  private fromCameraDir = new THREE.Vector3(0, 0, 1);
  private fromDistance = DEFAULT_CAMERA_DISTANCE;
  private targetDistance = DEFAULT_CAMERA_DISTANCE;
  private fromRotation = new THREE.Quaternion();
  private targetRotation = new THREE.Quaternion();
  private lastTargetKey = "";

  constructor(
    private readonly container: HTMLElement,
    private readonly networks: OverviewNetwork[],
    landCells: string[],
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
        this.addNode(node, network.slug, networkIndex, nodeIndex);
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

    // Reticle ring highlighting any custom geolocation returned by the TS camera policy
    this.targetReticle = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(
        circlePoints(NODE_RING_RADIUS * 1.35, 36),
      ),
      new THREE.LineBasicMaterial({
        color: 0x36d66b,
        transparent: true,
        opacity: 0.85,
      }),
    );
    this.targetReticle.visible = false;
    this.targetReticle.renderOrder = 7;
    this.globe.add(this.targetReticle);

    this.camera.position.set(0, 0, DEFAULT_CAMERA_DISTANCE);
    this.camera.lookAt(0, 0, 0);
    this.controls.target.set(0, 0, 0);
    this.controls.update();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.animate();
  }

  /**
   * Direct policy-driven geolocation camera target: smoothly slerps the globe
   * to center (target.lat, target.lng) and highlights the target node/network.
   */
  setCameraTarget(target: CameraTarget | null): void {
    if (!target) {
      this.targetReticle.visible = false;
      this.markers.forEach((m) => {
        m.active = false;
        m.ring.visible = false;
      });
      this.arcs.forEach((a) => {
        a.material.uniforms.uFocusGain.value = 0.85;
      });
      this.renderer.domElement.dataset.cameraTarget = "free";
      return;
    }

    const key = `${target.lat.toFixed(2)},${target.lng.toFixed(2)},${target.node ?? ""},${target.network ?? ""}`;
    this.renderer.domElement.dataset.cameraTarget = target.node
      ? `${target.node} (${target.lat.toFixed(2)},${target.lng.toFixed(2)})`
      : `${target.lat.toFixed(2)},${target.lng.toFixed(2)}`;

    const direction = latLngToVector(target.lat, target.lng, 1);
    this.targetReticle.position.copy(
      direction.clone().multiplyScalar(EARTH_RADIUS * 1.015),
    );
    this.targetReticle.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      direction,
    );
    this.targetReticle.visible = true;

    const focusNetIdx = target.network
      ? this.networks.findIndex((n) => n.slug === target.network)
      : -1;

    this.markers.forEach((marker) => {
      const isMatch =
        Boolean(target.node) &&
        marker.nodeName === target.node &&
        (!target.network || marker.networkSlug === target.network);
      marker.active = isMatch;
      marker.ring.visible = isMatch;
      marker.mesh.material.color.copy(marker.baseColor);
    });

    this.arcs.forEach((arc) => {
      arc.material.uniforms.uFocusGain.value =
        focusNetIdx < 0 || arc.networkIndex === focusNetIdx ? 1.0 : 0.42;
    });

    if (key === this.lastTargetKey || this.userDragging) {
      return;
    }
    this.lastTargetKey = key;

    const desiredRot = targetQuaternionForDirection(direction);
    const desiredDist =
      typeof target.distance === "number"
        ? THREE.MathUtils.clamp(target.distance, 120, 240)
        : DEFAULT_CAMERA_DISTANCE;

    if (this.reducedMotion) {
      this.globe.quaternion.copy(desiredRot);
      this.camera.position.set(0, 0, desiredDist);
      this.camera.lookAt(0, 0, 0);
      this.transitioning = false;
      return;
    }

    this.fromCameraDir.copy(this.camera.position).normalize();
    this.fromDistance = this.camera.position.length();
    this.targetDistance = desiredDist;
    this.fromRotation.copy(this.globe.quaternion);
    this.targetRotation.copy(desiredRot);
    this.transitionStart = performance.now();
    this.transitioning = true;
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
      });
      this.globe.add(line);
    });
  }

  private addNode(
    node: NetworkNode,
    networkSlug: string,
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
      opacity: 0.45,
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
      networkSlug,
      nodeName: node.name,
      networkIndex,
      nodeIndex,
      mesh,
      ring,
      baseColor: new THREE.Color(color),
      active: false,
    });
    this.globe.add(mesh, ring);
  }

  private updateCameraTransition(now: number): void {
    if (!this.transitioning || this.userDragging) return;
    const progress = Math.min(1, (now - this.transitionStart) / TRANSITION_MS);
    const eased = easeInOutCubic(progress);

    const cameraRot = new THREE.Quaternion().setFromUnitVectors(
      this.fromCameraDir,
      new THREE.Vector3(0, 0, 1),
    );
    const partial = new THREE.Quaternion().slerpQuaternions(
      new THREE.Quaternion(),
      cameraRot,
      eased,
    );
    const dir = this.fromCameraDir.clone().applyQuaternion(partial).normalize();
    const dist = THREE.MathUtils.lerp(
      this.fromDistance,
      this.targetDistance,
      eased,
    );
    this.camera.position.copy(dir).multiplyScalar(dist);
    this.camera.lookAt(0, 0, 0);
    this.globe.quaternion.slerpQuaternions(
      this.fromRotation,
      this.targetRotation,
      eased,
    );
    if (progress >= 1) {
      this.transitioning = false;
    }
  }

  private handleControlStart = (): void => {
    this.userDragging = true;
    this.transitioning = false;
  };

  private handleControlEnd = (): void => {
    this.userDragging = false;
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
    this.updateCameraTransition(now);
    const timeSec = now / 1000;
    this.cloudMaterial.uniforms.uTime.value = timeSec;
    this.geoOverlay.updatePulse(timeSec);
    if (!this.reducedMotion) {
      for (let i = 0; i < this.arcs.length; i += 1) {
        this.arcs[i].material.uniforms.uTime.value = timeSec;
      }
    }
    const pulse = 1.25 + Math.sin(now * 0.006) * 0.05;
    if (this.targetReticle.visible) {
      this.targetReticle.scale.setScalar(1 + Math.sin(now * 0.004) * 0.14);
    }
    this.markers.forEach((marker) => {
      marker.mesh.scale.setScalar(marker.active ? pulse : 1);
      const progress = this.reducedMotion
        ? 0.5
        : (now * 0.00055 + marker.nodeIndex * 0.33) % 1;
      marker.ring.scale.setScalar(0.75 + progress * 0.65);
      marker.ring.material.opacity = (1 - progress) * 0.8;
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
        float envelope = sin(clamp(vProgress, 0.0, 1.0) * 3.14159265);
        envelope = pow(max(envelope, 0.0), 0.7);

        float headFwd = fract(uTime * uSpeed + uPhase);
        float distFwd = mod(headFwd - vProgress + 1.0, 1.0);
        float pingFwd = exp(-distFwd * 8.0);

        float headBack = fract(uTime * uSpeed * 0.85 + uPhase + 0.5);
        float distBack = mod(vProgress - headBack + 1.0, 1.0);
        float pingBack = 0.55 * exp(-distBack * 10.5);

        float strand = 0.16 * envelope;
        float pulse = (pingFwd + pingBack) * envelope;
        float alpha = clamp((strand + pulse * 0.92) * uFocusGain, 0.0, 0.95);

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
