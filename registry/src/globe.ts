import { cellToBoundary, latLngToCell } from "h3-js";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { HexLayer } from "./hex-layer";
import type { NetworkNode } from "./types";

const EARTH_RADIUS = 50;
const DEG_TO_RAD = Math.PI / 180;

type LandPayload = {
  cells: string[];
};

export async function mountGlobe(
  container: HTMLElement,
  nodes: NetworkNode[],
): Promise<() => void> {
  const landCells = await loadLandCells();
  const globe = new RegistryGlobe(container, nodes, landCells);
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
  private readonly controls: OrbitControls;
  private readonly globe = new THREE.Group();
  private readonly hexLayer: HexLayer;
  private readonly markerPulses: THREE.Mesh[] = [];
  private readonly resizeObserver: ResizeObserver;
  private readonly startTime = performance.now();
  private frameId = 0;

  constructor(
    private readonly container: HTMLElement,
    nodes: NetworkNode[],
    landCells: string[],
  ) {
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.setAttribute(
      "aria-label",
      "Interactive H3 globe showing metal network nodes",
    );
    container.appendChild(this.renderer.domElement);

    this.camera.position.set(0, 0, 185);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.055;
    this.controls.enablePan = false;
    this.controls.minDistance = 120;
    this.controls.maxDistance = 250;
    this.controls.rotateSpeed = 0.45;
    this.controls.zoomSpeed = 0.7;

    this.scene.add(this.globe);
    // Center the initial view on the Atlantic so the US and EU nodes are
    // visible together. The globe stays put until the user orbits it.
    this.globe.rotation.y = -Math.PI / 4;
    this.addEarth();
    this.hexLayer = new HexLayer(landCells, EARTH_RADIUS);
    this.globe.add(this.hexLayer.group);
    nodes.forEach((node) => this.addMarker(node));
    this.positionGlobe();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.animate();
  }

  dispose(): void {
    cancelAnimationFrame(this.frameId);
    this.resizeObserver.disconnect();
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
    const color = new THREE.Color(node.online ? 0xf5f5f5 : 0x707070);
    const direction = latLngToVector(node.lat, node.lng, 1);
    const base = direction.clone().multiplyScalar(EARTH_RADIUS * 1.006);
    const tip = direction.clone().multiplyScalar(EARTH_RADIUS + 2.5);

    const cell = latLngToCell(node.lat, node.lng, 3);
    const cellBoundary = cellToBoundary(cell, true).map(([lng, lat]) =>
      latLngToVector(lat, lng, EARTH_RADIUS * 1.008),
    );
    const cellOutline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(cellBoundary),
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: node.online ? 0.95 : 0.45,
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

  private positionGlobe(): void {
    this.globe.position.set(0, 0, 0);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  private resize(): void {
    const width = Math.max(this.container.clientWidth, 1);
    const height = Math.max(this.container.clientHeight, 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.positionGlobe();
  }

  private animate = (): void => {
    this.frameId = requestAnimationFrame(this.animate);
    const elapsed = (performance.now() - this.startTime) / 1000;
    this.markerPulses.forEach((pulse) => {
      const wave = (elapsed * 0.7 + Number(pulse.userData.phase)) % 1;
      pulse.scale.setScalar(1 + wave * 1.8);
      (pulse.material as THREE.MeshBasicMaterial).opacity =
        0.74 * (1 - wave);
    });
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };
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
