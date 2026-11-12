import * as THREE from "three";

// Ported from timcash/dialtone src/hud/app.js (e75febb).
export function createHudOutlineMaterial(
  outlinePx = 1.6,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    transparent: true,
    uniforms: {
      uColor: { value: new THREE.Color(hudToken("--ink-2", "#9c9c9c")) },
      uOutlinePx: { value: outlinePx },
      uOpacity: { value: 1 },
      uResolution: {
        value: new THREE.Vector2(window.innerWidth, window.innerHeight),
      },
    },
    vertexShader: `
      uniform float uOutlinePx;
      uniform vec2 uResolution;
      void main() {
        vec4 clipPosition = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vec3 viewNormal = normalize(normalMatrix * normal);
        vec2 clipNormal = normalize((projectionMatrix * vec4(viewNormal, 0.0)).xy);
        vec2 offset = (clipNormal * uOutlinePx * 2.0) / max(uResolution, vec2(1.0));
        clipPosition.xy += offset * clipPosition.w;
        gl_Position = clipPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      void main() {
        gl_FragColor = vec4(uColor, uOpacity);
      }
    `,
  });
}

export function createHudCloudMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 0.11 },
    },
    vertexShader: `
      varying vec3 vObjectNormal;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPosition;
      void main() {
        vObjectNormal = normalize(position);
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uOpacity;
      varying vec3 vObjectNormal;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPosition;
      float hash(vec3 p) {
        p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      float noise(vec3 x) {
        vec3 i = floor(x);
        vec3 f = fract(x);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
              mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
          mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
              mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y),
          f.z
        );
      }
      float fbm(vec3 p) {
        float value = 0.0;
        float amp = 0.5;
        for (int i = 0; i < 4; i++) {
          value += amp * noise(p);
          p = p * 2.03 + vec3(0.17, -0.11, 0.23);
          amp *= 0.5;
        }
        return value;
      }
      void main() {
        vec3 p = normalize(vObjectNormal);
        vec3 drift = vec3(uTime * 0.014, -uTime * 0.005, uTime * 0.010);
        float base = fbm(p * 3.4 + drift);
        float detail = fbm(p * 6.8 - drift * 1.4);
        float bands = sin((p.y * 8.5) + base * 2.6 + uTime * 0.04) * 0.5 + 0.5;
        float cloud = smoothstep(0.56, 0.79, base * 0.65 + detail * 0.35) *
          smoothstep(0.24, 0.86, bands);
        vec3 viewDir = normalize(cameraPosition - vWorldPosition);
        float limb = 1.0 - max(dot(normalize(vWorldNormal), viewDir), 0.0);
        float rimBoost = mix(0.85, 1.25, pow(limb, 1.5));
        float alpha = cloud * uOpacity * rimBoost;
        if (alpha < 0.015) discard;
        gl_FragColor = vec4(vec3(0.68), alpha);
      }
    `,
  });
}

export function createHudAtmosphereMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Color(hudToken("--ink-2", "#9c9c9c")) },
      uStrength: { value: 0.12 },
    },
    vertexShader: `
      varying vec3 vWorldNormal;
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uStrength;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPosition;
      void main() {
        vec3 viewDir = normalize(cameraPosition - vWorldPosition);
        float rim = 1.0 - abs(dot(normalize(vWorldNormal), viewDir));
        float glow = pow(clamp(rim, 0.0, 1.0), 2.9) * uStrength;
        if (glow < 0.01) discard;
        gl_FragColor = vec4(uColor, glow);
      }
    `,
  });
}

function hudToken(name: string, fallback: string): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
    fallback
  );
}
