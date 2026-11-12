import { latLngToCell } from "h3-js";
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
  private readonly camera = new THREE.PerspectiveCamera(46, 1, 0.1, 2000);
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
    this.scene.fog = new THREE.FogExp2(0x020407, 0.0019);
    this.renderer.setClearColor(0x020407, 1);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.setAttribute(
      "aria-label",
      "Interactive H3 globe showing metal network nodes",
    );
    container.appendChild(this.renderer.domElement);

    this.camera.position.set(0, 8, 146);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.055;
    this.controls.enablePan = false;
    this.controls.minDistance = 82;
    this.controls.maxDistance = 205;
    this.controls.rotateSpeed = 0.45;
    this.controls.zoomSpeed = 0.7;

    this.scene.add(this.globe);
    this.addStars();
    this.addEarth();
    this.hexLayer = new HexLayer(landCells, EARTH_RADIUS + 0.38, [
      new THREE.Color(0x164a55),
      new THREE.Color(0x1d6570),
      new THREE.Color(0x287580),
      new THREE.Color(0x123c47),
    ]);
    this.globe.add(this.hexLayer.mesh);
    nodes.forEach((node) => this.addMarker(node));
    this.addLights();
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
      new THREE.SphereGeometry(EARTH_RADIUS, 72, 72),
      new THREE.MeshStandardMaterial({
        color: 0x061423,
        emissive: 0x020810,
        roughness: 0.82,
        metalness: 0.12,
      }),
    );
    this.globe.add(earth);

    const grid = new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.SphereGeometry(50.12, 36, 24)),
      new THREE.LineBasicMaterial({
        color: 0x1e6370,
        transparent: true,
        opacity: 0.11,
      }),
    );
    this.globe.add(grid);

    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_RADIUS + 3.2, 64, 64),
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
            float rim = pow(1.0 - max(dot(vNormal, viewDirection), 0.0), 3.0);
            gl_FragColor = vec4(0.12, 0.73, 0.84, rim * 0.55);
          }
        `,
      }),
    );
    this.globe.add(atmosphere);
  }

  private addMarker(node: NetworkNode): void {
    const color = new THREE.Color(node.online ? 0x74f5df : 0xff6a72);
    const direction = latLngToVector(node.lat, node.lng, 1);
    const base = direction.clone().multiplyScalar(EARTH_RADIUS + 0.7);
    const tip = direction.clone().multiplyScalar(EARTH_RADIUS + 5.8);

    const lineGeometry = new THREE.BufferGeometry().setFromPoints([base, tip]);
    const line = new THREE.Line(
      lineGeometry,
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.85,
      }),
    );
    this.globe.add(line);

    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.95, 16, 16),
      new THREE.MeshBasicMaterial({ color }),
    );
    marker.position.copy(tip);
    marker.userData.nodeName = node.name;
    this.globe.add(marker);

    const pulse = new THREE.Mesh(
      new THREE.RingGeometry(1.25, 1.65, 32),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.62,
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

  private addLights(): void {
    this.scene.add(new THREE.HemisphereLight(0x91e8ff, 0x020509, 1.25));
    const key = new THREE.DirectionalLight(0xc5f8ff, 2.8);
    key.position.set(100, 65, 110);
    this.scene.add(key);
    const edge = new THREE.DirectionalLight(0x2859ff, 1.15);
    edge.position.set(-90, -25, -80);
    this.scene.add(edge);
  }

  private addStars(): void {
    const positions: number[] = [];
    let seed = 0x3d1a17;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };

    for (let index = 0; index < 950; index += 1) {
      const radius = 280 + random() * 450;
      const theta = random() * Math.PI * 2;
      const phi = Math.acos(2 * random() - 1);
      positions.push(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.cos(phi),
        radius * Math.sin(phi) * Math.sin(theta),
      );
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    const points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        color: 0x9ec5d1,
        size: 0.8,
        transparent: true,
        opacity: 0.7,
        sizeAttenuation: true,
      }),
    );
    this.scene.add(points);
  }

  private positionGlobe(): void {
    const horizontalOffset =
      this.container.clientWidth >= 900
        ? -Math.min(22, this.container.clientWidth / 70)
        : 0;
    this.globe.position.x = horizontalOffset;
    this.controls.target.set(horizontalOffset, 0, 0);
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
    this.globe.rotation.y = elapsed * 0.025;
    this.markerPulses.forEach((pulse) => {
      const wave = (elapsed * 0.7 + Number(pulse.userData.phase)) % 1;
      pulse.scale.setScalar(1 + wave * 1.8);
      (pulse.material as THREE.MeshBasicMaterial).opacity =
        0.62 * (1 - wave);
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
  const lngRad = lng * DEG_TO_RAD;
  return new THREE.Vector3(
    radius * Math.cos(latRad) * Math.sin(lngRad),
    radius * Math.sin(latRad),
    radius * Math.cos(latRad) * Math.cos(lngRad),
  );
}
