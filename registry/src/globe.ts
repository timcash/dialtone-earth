import { cellToBoundary, latLngToCell } from "h3-js";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { HexLayer } from "./hex-layer";
import type { GlobePlan } from "./overview";
import { sampleTour, shouldAnimateTour, TOUR_STOP_MS } from "./tour";
import type { NetworkNode } from "./types";

const EARTH_RADIUS = 50;
const DEG_TO_RAD = Math.PI / 180;
const DOT_RADIUS = EARTH_RADIUS + 1.6;

type LandPayload = {
  cells: string[];
};

type TourControls = {
  toggle: HTMLButtonElement;
  next: HTMLButtonElement;
  label: HTMLElement;
};

type GlobeMode =
  | { nodes: NetworkNode[] }
  | { plan: GlobePlan; ui: TourControls };

export async function mountGlobe(
  container: HTMLElement,
  mode: GlobeMode,
): Promise<() => void> {
  const landCells = await loadLandCells();
  const globe = new RegistryGlobe(container, mode, landCells);
  return () => globe.dispose();
}

async function loadLandCells(): Promise<string[]> {
  try {
    const response = await fetch("/land.h3.json", { signal: AbortSignal.timeout(10_000) });
    if (response.ok) {
      const payload = (await response.json()) as LandPayload | string[];
      const cells = Array.isArray(payload) ? payload : payload.cells;
      if (Array.isArray(cells) && cells.length > 0) return cells;
    }
  } catch {
    // The generated fallback still renders an H3 globe if the asset is missing.
  }

  const cells = new Set<string>();
  for (let lat = -80; lat <= 80; lat += 10) {
    for (let lng = -180; lng < 180; lng += 10) {
      cells.add(latLngToCell(lat, lng, 3));
    }
  }
  return [...cells];
}

class RegistryGlobe {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(34, 1, 0.1, 2000);
  private readonly renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
  });
  private readonly controls?: OrbitControls;
  private readonly globe = new THREE.Group();
  private readonly hexLayer: HexLayer;
  private readonly markerPulses: THREE.Mesh[] = [];
  private readonly resizeObserver: ResizeObserver;
  private readonly intersectionObserver?: IntersectionObserver;
  private readonly motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private readonly tourDirections: THREE.Vector3[];
  private readonly tourRotations: THREE.Quaternion[];
  private readonly cameraRotation = new THREE.Quaternion();
  private readonly cameraDirection = new THREE.Vector3();
  private inView = false;
  private paused = false;
  private elapsed = 0;
  private lastFrame: number | undefined;
  private labeledStop = -1;
  private frameId = 0;

  constructor(
    private readonly container: HTMLElement,
    private readonly mode: GlobeMode,
    landCells: string[],
  ) {
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, "plan" in mode ? 1.5 : 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.setAttribute("aria-hidden", "true");
    container.appendChild(this.renderer.domElement);

    this.camera.position.set(0, 0, 185);
    this.scene.add(this.globe);
    this.globe.rotation.y = -Math.PI / 4;
    this.addEarth();
    this.hexLayer = new HexLayer(landCells, EARTH_RADIUS);
    this.globe.add(this.hexLayer.group);

    const axis = new THREE.Vector3(0, 1, 0);
    const stops = "plan" in mode ? mode.plan.stops : [];
    this.tourDirections = stops.map(({ lat, lng }) =>
      latLngToVector(lat, lng, 1).applyAxisAngle(axis, this.globe.rotation.y),
    );
    this.tourRotations = this.tourDirections.map((from, index, directions) =>
      new THREE.Quaternion().setFromUnitVectors(from, directions[(index + 1) % directions.length]),
    );

    if ("plan" in mode) {
      this.addNetworkGroups(mode.plan);
      mode.ui.toggle.addEventListener("click", this.toggleTour);
      mode.ui.next.addEventListener("click", this.nextStop);
      if (typeof IntersectionObserver === "function") {
        this.intersectionObserver = new IntersectionObserver((entries) => {
          const newest = entries.reduce<IntersectionObserverEntry | undefined>(
            (latest, entry) => !latest || entry.time >= latest.time ? entry : latest,
            undefined,
          );
          if (!newest) return;
          this.inView = newest.isIntersecting;
          this.updateAnimation();
        });
        this.intersectionObserver.observe(container);
      } else {
        this.inView = true;
      }
    } else {
      this.inView = true;
      this.controls = new OrbitControls(this.camera, this.renderer.domElement);
      this.controls.dampingFactor = 0.055;
      this.controls.enablePan = false;
      this.controls.minDistance = 120;
      this.controls.maxDistance = 250;
      this.controls.rotateSpeed = 0.45;
      this.controls.zoomSpeed = 0.7;
      mode.nodes.forEach((node) => this.addMarker(node));
    }

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    document.addEventListener("visibilitychange", this.updateAnimation);
    this.motion.addEventListener("change", this.updateAnimation);
    this.resize();
    this.updateAnimation();
  }

  dispose(): void {
    cancelAnimationFrame(this.frameId);
    this.resizeObserver.disconnect();
    this.intersectionObserver?.disconnect();
    document.removeEventListener("visibilitychange", this.updateAnimation);
    this.motion.removeEventListener("change", this.updateAnimation);
    this.controls?.dispose();
    if ("plan" in this.mode) {
      this.mode.ui.toggle.removeEventListener("click", this.toggleTour);
      this.mode.ui.next.removeEventListener("click", this.nextStop);
    }
    this.globe.remove(this.hexLayer.group);
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
      if (object instanceof THREE.InstancedMesh) object.dispose();
      object.geometry.dispose();
      const materials = Array.isArray(object.material)
        ? object.material
        : [object.material];
      materials.forEach((material) => material.dispose());
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private addNetworkGroups(plan: GlobePlan): void {
    const nodeCount = plan.groups.reduce((total, group) => total + group.nodes.length, 0);
    if (!nodeCount) return;
    const dots = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.9, 8, 6),
      new THREE.MeshBasicMaterial(),
      nodeCount,
    );
    const transform = new THREE.Matrix4();
    const linePositions: number[] = [];
    const lineColors: number[] = [];
    let dotIndex = 0;

    plan.groups.forEach(({ nodes }, index) => {
      const hue = (0.46 + index * 0.618034) % 1;
      const color = new THREE.Color().setHSL(hue, 0.7, 0.68, THREE.SRGBColorSpace);
      const directions = nodes.map(({ lat, lng }) => latLngToVector(lat, lng, 1));
      directions.forEach((direction, nodeIndex) => {
        const point = direction.clone().multiplyScalar(DOT_RADIUS);
        dots.setMatrixAt(dotIndex, transform.makeTranslation(point.x, point.y, point.z));
        dots.setColorAt(dotIndex, color);
        dotIndex += 1;

        // Join consecutive locations within this snapshot as a visual grouping.
        const previous = directions[nodeIndex - 1];
        if (!previous || previous.distanceToSquared(direction) < 1e-10) return;
        const rotation = new THREE.Quaternion().setFromUnitVectors(previous, direction);
        const stepRotation = new THREE.Quaternion();
        let start = previous.clone().multiplyScalar(DOT_RADIUS);
        const steps = 24;
        for (let step = 1; step <= steps; step += 1) {
          const progress = step / steps;
          stepRotation.identity().slerp(rotation, progress);
          const radius = DOT_RADIUS + Math.sin(Math.PI * progress) * 3;
          const end = previous.clone().applyQuaternion(stepRotation).multiplyScalar(radius);
          linePositions.push(start.x, start.y, start.z, end.x, end.y, end.z);
          lineColors.push(color.r, color.g, color.b, color.r, color.g, color.b);
          start = end;
        }
      });
    });

    this.globe.add(dots);
    if (linePositions.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(linePositions, 3));
      geometry.setAttribute("color", new THREE.Float32BufferAttribute(lineColors, 3));
      this.globe.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.58,
      })));
    }
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
        opacity: 0.42,
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

  private addMarker(node: NetworkNode): void {
    const { lat, lng } = node;
    if (typeof lat !== "number" || !(lat >= -90 && lat <= 90) ||
        typeof lng !== "number" || !(lng >= -180 && lng <= 180)) return;
    const online = node.online === true;
    const color = new THREE.Color(online ? 0xf5f5f5 : 0x707070);
    const direction = latLngToVector(lat, lng, 1);
    const base = direction.clone().multiplyScalar(EARTH_RADIUS * 1.006);
    const tip = direction.clone().multiplyScalar(EARTH_RADIUS + 2.5);

    const cell = latLngToCell(lat, lng, 3);
    const cellBoundary = cellToBoundary(cell, true).map(([lng, lat]) =>
      latLngToVector(lat, lng, EARTH_RADIUS * 1.008),
    );
    const cellOutline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(cellBoundary),
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: online ? 0.95 : 0.45,
      }),
    );
    this.globe.add(cellOutline);

    const lineGeometry = new THREE.BufferGeometry().setFromPoints([base, tip]);
    const line = new THREE.Line(
      lineGeometry,
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.9,
      }),
    );
    this.globe.add(line);

    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.36, 12, 12),
      new THREE.MeshBasicMaterial({ color }),
    );
    marker.position.copy(tip);
    marker.userData.nodeName = node.name;
    this.globe.add(marker);

    const pulse = new THREE.Mesh(
      new THREE.RingGeometry(0.88, 1.08, 32),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.74,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    pulse.position.copy(base.clone().add(direction.clone().multiplyScalar(0.08)));
    pulse.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      direction,
    );
    pulse.userData.phase = this.markerPulses.length * 0.83;
    this.markerPulses.push(pulse);
    this.globe.add(pulse);
  }

  private resize(): void {
    const width = Math.max(this.container.clientWidth, 1);
    const height = Math.max(this.container.clientHeight, 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.draw();
  }

  private updateAnimation = (): void => {
    const visible = this.inView && !document.hidden;
    let animate = visible;
    if ("plan" in this.mode) {
      const { plan, ui } = this.mode;
      ui.toggle.hidden = this.motion.matches || plan.stops.length < 2;
      ui.next.hidden = plan.stops.length < 2;
      ui.toggle.textContent = this.paused ? "Play tour" : "Pause tour";
      animate = shouldAnimateTour({
        hidden: document.hidden,
        inView: this.inView,
        reducedMotion: this.motion.matches,
        paused: this.paused,
        stopCount: plan.stops.length,
      });
    }
    if (this.controls) this.controls.enableDamping = !this.motion.matches;

    if (animate) {
      if (!this.frameId) this.frameId = requestAnimationFrame(this.animate);
    } else {
      cancelAnimationFrame(this.frameId);
      this.frameId = 0;
      this.lastFrame = undefined;
      if (visible) this.draw();
    }
  };

  private toggleTour = (): void => {
    this.paused = !this.paused;
    this.updateAnimation();
  };

  private nextStop = (): void => {
    this.elapsed = (Math.floor(this.elapsed / TOUR_STOP_MS) + 1) * TOUR_STOP_MS;
    this.lastFrame = undefined;
    this.draw();
  };

  private animate = (timestamp: number): void => {
    if (this.lastFrame !== undefined) this.elapsed += Math.min(timestamp - this.lastFrame, 100);
    this.lastFrame = timestamp;
    this.draw();
    this.frameId = requestAnimationFrame(this.animate);
  };

  private draw(): void {
    if (document.hidden) return;
    if ("plan" in this.mode) {
      this.positionTourCamera(this.mode.plan, this.mode.ui);
    } else {
      this.markerPulses.forEach((pulse) => {
        const wave = (this.elapsed * 0.0007 + Number(pulse.userData.phase)) % 1;
        pulse.visible = !this.motion.matches;
        pulse.scale.setScalar(1 + wave * 1.8);
        (pulse.material as THREE.MeshBasicMaterial).opacity = 0.74 * (1 - wave);
      });
      this.controls?.update();
    }
    this.renderer.render(this.scene, this.camera);
  }

  private positionTourCamera(plan: GlobePlan, ui: TourControls): void {
    const fit = Math.min(this.camera.aspect, 1);
    if (!plan.stops.length) {
      this.camera.position.set(0, 0, 210 / fit);
      this.camera.lookAt(0, 0, 0);
      ui.label.textContent = "No tour stops available.";
      return;
    }
    const { from, to, progress } = sampleTour(this.elapsed, plan.stops.length);
    const distance = (index: number) => plan.stops[index].node === null ? 225 : 185;
    const radius = THREE.MathUtils.lerp(distance(from), distance(to), progress) / fit;
    this.cameraRotation.identity().slerp(this.tourRotations[from], progress);
    this.cameraDirection.copy(this.tourDirections[from]).applyQuaternion(this.cameraRotation);
    this.camera.position.copy(this.cameraDirection).multiplyScalar(radius);
    this.camera.lookAt(0, 0, 0);

    const stop = progress < 0.5 ? from : to;
    if (stop !== this.labeledStop) {
      this.labeledStop = stop;
      const { network, node } = plan.stops[stop];
      const label = node === null ? `${network} overview` : `${network} / ${node}`;
      ui.label.textContent = label;
      ui.label.title = label;
    }
  }
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
