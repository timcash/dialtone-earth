import { latLngToCell } from "h3-js";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { HexLayer } from "./hex-layer";
import type { NetworkNode, OverviewNetwork } from "./types";

const EARTH_RADIUS = 50;
const DEG_TO_RAD = Math.PI / 180;
const NETWORK_DISTANCE = 205;
const NODE_DISTANCE = 160;
const TRANSITION_MS = 2_700;
const DWELL_MS = 1_900;
const RESUME_DELAY_MS = 5_000;

type LandPayload = {
  cells: string[];
};

type TourStop = {
  networkIndex: number;
  nodeIndex: number | null;
  direction: THREE.Vector3;
  distance: number;
};

type MarkerVisual = {
  networkIndex: number;
  nodeIndex: number;
  mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  baseColor: THREE.Color;
  active: boolean;
};

type ArcVisual = {
  networkIndex: number;
  material: THREE.LineBasicMaterial | THREE.LineDashedMaterial;
  baseOpacity: number;
};

export async function mountOverviewGlobe(
  container: HTMLElement,
  networks: OverviewNetwork[],
  onFocus: (networkSlug: string) => void,
): Promise<() => void> {
  const landCells = await loadLandCells();
  const globe = new OverviewGlobe(
    container,
    networks,
    landCells,
    onFocus,
  );
  return () => globe.dispose();
}

async function loadLandCells(): Promise<string[]> {
  try {
    const response = await fetch("/land.h3.json");
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
  private readonly camera = new THREE.PerspectiveCamera(34, 1, 0.1, 2000);
  private readonly renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
  });
  private readonly controls: OrbitControls;
  private readonly globe = new THREE.Group();
  private readonly hexLayer: HexLayer;
  private readonly markers: MarkerVisual[] = [];
  private readonly arcs: ArcVisual[] = [];
  private readonly stops: TourStop[] = [];
  private readonly resizeObserver: ResizeObserver;
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
  private interrupted = false;
  private resumeAt = Number.POSITIVE_INFINITY;

  constructor(
    private readonly container: HTMLElement,
    private readonly networks: OverviewNetwork[],
    landCells: string[],
    private readonly onFocus: (networkSlug: string) => void,
  ) {
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.setAttribute(
      "aria-label",
      "Interactive H3 globe touring all dialtone networks",
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
    networks.forEach((network, networkIndex) => {
      this.addNetwork(network, networkIndex);
    });
    this.buildTour();

    if (this.stops.length > 0) {
      const first = this.stops[0];
      this.camera.position
        .copy(first.direction)
        .multiplyScalar(first.distance);
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

  dispose(): void {
    cancelAnimationFrame(this.frameId);
    this.resizeObserver.disconnect();
    this.controls.removeEventListener("start", this.handleControlStart);
    this.controls.removeEventListener("end", this.handleControlEnd);
    this.controls.dispose();
    this.hexLayer.dispose();
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
    const earth = new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_RADIUS, 48, 36),
      new THREE.MeshBasicMaterial({
        colorWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      }),
    );
    this.globe.add(earth);

    const graticule = new THREE.LineSegments(
      createGraticuleGeometry(EARTH_RADIUS * 1.002),
      new THREE.LineBasicMaterial({
        color: 0x474747,
        transparent: true,
        opacity: 0.4,
      }),
    );
    this.globe.add(graticule);

    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_RADIUS * 1.055, 48, 36),
      new THREE.ShaderMaterial({
        transparent: true,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        vertexShader: `
          varying vec3 vNormal;
          varying vec3 vWorldPosition;
          void main() {
            vNormal = normalize(mat3(modelMatrix) * normal);
            vec4 worldPosition = modelMatrix * vec4(position, 1.0);
            vWorldPosition = worldPosition.xyz;
            gl_Position = projectionMatrix * viewMatrix * worldPosition;
          }
        `,
        fragmentShader: `
          varying vec3 vNormal;
          varying vec3 vWorldPosition;
          void main() {
            vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
            float rim = 1.0 - abs(dot(normalize(vNormal), viewDirection));
            float glow = pow(clamp(rim, 0.0, 1.0), 2.9) * 0.22;
            if (glow < 0.01) discard;
            gl_FragColor = vec4(vec3(0.62), glow);
          }
        `,
      }),
    );
    this.globe.add(atmosphere);
  }

  private addNetwork(
    network: OverviewNetwork,
    networkIndex: number,
  ): void {
    const style = networkStyle(networkIndex);
    network.snapshot.nodes.forEach((node, nodeIndex) => {
      this.addNode(node, networkIndex, nodeIndex, style.color);
    });

    const nodes = network.snapshot.nodes;
    const pairs: Array<[NetworkNode, NetworkNode]> = [];
    if (nodes.length <= 12) {
      for (let left = 0; left < nodes.length; left += 1) {
        for (let right = left + 1; right < nodes.length; right += 1) {
          pairs.push([nodes[left], nodes[right]]);
        }
      }
    } else {
      for (let index = 1; index < nodes.length; index += 1) {
        pairs.push([nodes[0], nodes[index]]);
      }
    }

    pairs.forEach(([from, to]) => {
      const geometry = new THREE.BufferGeometry().setFromPoints(
        greatCirclePoints(from, to),
      );
      const material =
        style.dashSize === null
          ? new THREE.LineBasicMaterial({
              color: style.color,
              transparent: true,
              opacity: style.opacity,
            })
          : new THREE.LineDashedMaterial({
              color: style.color,
              transparent: true,
              opacity: style.opacity,
              dashSize: style.dashSize,
              gapSize: style.gapSize,
            });
      const line = new THREE.Line(geometry, material);
      if (material instanceof THREE.LineDashedMaterial) {
        line.computeLineDistances();
      }
      line.renderOrder = 3;
      this.arcs.push({
        networkIndex,
        material,
        baseOpacity: style.opacity,
      });
      this.globe.add(line);
    });
  }

  private addNode(
    node: NetworkNode,
    networkIndex: number,
    nodeIndex: number,
    color: number,
  ): void {
    const direction = latLngToVector(node.lat, node.lng, 1);
    const position = direction
      .clone()
      .multiplyScalar(EARTH_RADIUS * 1.026);
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: node.online ? 1 : 0.45,
    });
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.62, 14, 14),
      material,
    );
    mesh.position.copy(position);
    mesh.renderOrder = 5;

    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.88, 1.08, 32),
      ringMaterial,
    );
    ring.position.copy(
      direction.clone().multiplyScalar(EARTH_RADIUS * 1.029),
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
        direction:
          networkDirection.lengthSq() > 0
            ? networkDirection
            : new THREE.Vector3(0, 0, 1),
        distance: NETWORK_DISTANCE,
      });
      directions.forEach((direction, nodeIndex) => {
        this.stops.push({
          networkIndex,
          nodeIndex,
          direction,
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
        marker.active ? new THREE.Color(0xffffff) : marker.baseColor,
      );
    });
    this.arcs.forEach((arc) => {
      arc.material.opacity =
        arc.networkIndex === stop.networkIndex
          ? Math.min(0.9, arc.baseOpacity + 0.24)
          : Math.max(0.12, arc.baseOpacity * 0.38);
    });
  }

  private beginTransition(stopIndex: number, now: number): void {
    if (this.stops.length === 0) return;
    this.targetStopIndex = stopIndex % this.stops.length;
    this.transitionFromDirection
      .copy(this.camera.position)
      .normalize();
    this.transitionFromDistance = this.camera.position.length();
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
    const rotation = new THREE.Quaternion().setFromUnitVectors(
      this.transitionFromDirection,
      target.direction,
    );
    const partial = new THREE.Quaternion().slerpQuaternions(
      new THREE.Quaternion(),
      rotation,
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
  }

  private animate = (): void => {
    this.frameId = requestAnimationFrame(this.animate);
    const now = performance.now();
    this.updateTour(now);
    const pulse = 1.9 + Math.sin(now * 0.006) * 0.22;
    this.markers.forEach((marker) => {
      marker.mesh.scale.setScalar(marker.active ? pulse : 1);
      if (marker.active) {
        marker.ring.scale.setScalar(
          this.reducedMotion ? 1.4 : 1.35 + Math.sin(now * 0.004) * 0.2,
        );
        marker.ring.material.opacity = 0.82;
      }
    });
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };
}

function networkStyle(index: number): {
  color: number;
  opacity: number;
  dashSize: number | null;
  gapSize: number;
} {
  const styles = [
    { color: 0xdedede, opacity: 0.58, dashSize: null, gapSize: 0 },
    { color: 0xb5b5b5, opacity: 0.62, dashSize: 2.2, gapSize: 1.1 },
    { color: 0x8c8c8c, opacity: 0.7, dashSize: 0.9, gapSize: 0.8 },
    { color: 0xf2f2f2, opacity: 0.5, dashSize: 3.4, gapSize: 1.6 },
  ];
  return styles[index % styles.length];
}

function greatCirclePoints(
  from: NetworkNode,
  to: NetworkNode,
): THREE.Vector3[] {
  const start = latLngToVector(from.lat, from.lng, 1);
  const end = latLngToVector(to.lat, to.lng, 1);
  const angle = Math.acos(
    THREE.MathUtils.clamp(start.dot(end), -1, 1),
  );
  const sinAngle = Math.sin(angle);
  const points: THREE.Vector3[] = [];
  const segments = 56;

  for (let index = 0; index <= segments; index += 1) {
    const progress = index / segments;
    let direction: THREE.Vector3;
    if (Math.abs(sinAngle) < 0.0001) {
      direction = start.clone().lerp(end, progress).normalize();
    } else {
      const left = Math.sin((1 - progress) * angle) / sinAngle;
      const right = Math.sin(progress * angle) / sinAngle;
      direction = start
        .clone()
        .multiplyScalar(left)
        .add(end.clone().multiplyScalar(right))
        .normalize();
    }
    const lift =
      Math.sin(Math.PI * progress) * (3.8 + angle * 2.4);
    points.push(
      direction.multiplyScalar(EARTH_RADIUS * 1.026 + lift),
    );
  }
  return points;
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

function easeInOutCubic(value: number): number {
  return value < 0.5
    ? 4 * value * value * value
    : 1 - Math.pow(-2 * value + 2, 3) / 2;
}
