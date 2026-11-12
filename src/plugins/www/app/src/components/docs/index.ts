import * as THREE from "three";
import { FpsCounter } from "../util/fps";
import { GpuTimer } from "../util/gpu_timer";
import { VisibilityMixin } from "../util/section";
import cubeGlowVert from "../../shaders/template-cube.vert.glsl?raw";
import cubeGlowFrag from "../../shaders/template-cube.frag.glsl?raw";
import { startTyping } from "../util/typing";

/**
 * Docs section: Three.js section like the others. Cube + key light + glow,
 * overlay with WWW workflow bash commands.
 */

class DocsVisualization {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  container: HTMLElement;
  frameId = 0;
  resizeObserver?: ResizeObserver;
  gl!: WebGLRenderingContext | WebGL2RenderingContext;
  gpuTimer = new GpuTimer();
  isVisible = true;
  private fpsCounter = new FpsCounter("docs");
  private cube!: THREE.Mesh;
  private cubeMaterial!: THREE.ShaderMaterial;
  private keyLight!: THREE.DirectionalLight;
  private time = 0;
  private lightDir = new THREE.Vector3(1, 1, 1).normalize();
  frameCount = 0;

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer.setClearColor(0x0a0a12, 1);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const canvas = this.renderer.domElement;
    canvas.style.position = "absolute";
    canvas.style.top = "0";
    canvas.style.left = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";

    const existingCanvas = container.querySelector("canvas");
    if (existingCanvas) {
      this.renderer.domElement = existingCanvas as HTMLCanvasElement;
    } else {
      this.container.appendChild(canvas);
    }

    this.camera.position.set(0, 0, 3);
    this.camera.lookAt(0, 0, 0);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.4));

    this.keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
    this.keyLight.position.set(2, 2, 2);
    this.scene.add(this.keyLight);

    const cubeGeo = new THREE.BoxGeometry(1, 1, 1);
    this.cubeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0x446688) },
        uGlowColor: { value: new THREE.Color(0x6688aa) },
        uLightDir: { value: this.lightDir.clone() },
        uTime: { value: 0 },
      },
      vertexShader: cubeGlowVert,
      fragmentShader: cubeGlowFrag,
    });
    this.cube = new THREE.Mesh(cubeGeo, this.cubeMaterial);
    this.scene.add(this.cube);

    this.resize();
    this.animate();

    this.gl = this.renderer.getContext();
    this.gpuTimer.init(this.gl);

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.container);
    } else {
      window.addEventListener("resize", this.resize);
    }
  }

  resize = () => {
    const rect = this.container.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  };

  dispose() {
    cancelAnimationFrame(this.frameId);
    this.resizeObserver?.disconnect();
    window.removeEventListener("resize", this.resize);
    this.renderer.dispose();
    if (this.container.contains(this.renderer.domElement)) {
      this.container.removeChild(this.renderer.domElement);
    }
  }

  setVisible(visible: boolean) {
    VisibilityMixin.setVisible(this, visible, "docs");
    if (!visible) this.fpsCounter.clear();
  }

  animate = () => {
    this.frameId = requestAnimationFrame(this.animate);
    if (!this.isVisible) return;

    this.time += 0.016;
    this.frameCount++;
    this.cube.rotation.x = this.time * 0.3;
    this.cube.rotation.y = this.time * 0.2;

    this.lightDir.set(1, 1, 1).normalize();
    this.cubeMaterial.uniforms.uLightDir.value.copy(this.lightDir).transformDirection(this.camera.matrixWorldInverse);
    this.cubeMaterial.uniforms.uTime.value = this.time;

    const cpuStart = performance.now();
    this.gpuTimer.begin(this.gl);
    this.renderer.render(this.scene, this.camera);
    this.gpuTimer.end(this.gl);
    this.gpuTimer.poll(this.gl);
    const cpuMs = performance.now() - cpuStart;
    this.fpsCounter.tick(cpuMs, this.gpuTimer.lastMs);
  };
}

export function mountDocs(container: HTMLElement) {
  container.innerHTML = `
    <div class="marketing-overlay" aria-label="Docs section: WWW workflow">
      <h2>WWW workflow</h2>
      <p data-typing-subtitle></p>
      <pre class="docs-bash"><code>./dialtone.sh www dev
./dialtone.sh www build
./dialtone.sh www publish
git push origin main  # registry deploys via GitHub Actions
./dialtone.sh www radio demo</code></pre>
    </div>
  `;

  const subtitleEl = container.querySelector(
    "[data-typing-subtitle]"
  ) as HTMLParagraphElement | null;
  const subtitles = [
    "Develop locally and deploy the registry to Cloudflare Workers.",
    "Push registry changes to main for automatic deployment.",
    "Automate docs and workflows for teams.",
  ];
  const stopTyping = startTyping(subtitleEl, subtitles);

  const viz = new DocsVisualization(container);
  return {
    dispose: () => {
      viz.dispose();
      stopTyping();
      container.innerHTML = "";
    },
    setVisible: (visible: boolean) => viz.setVisible(visible),
    updateUI: () => {
        // No menu yet
    }
  };
}
