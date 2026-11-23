import * as THREE from "three";

// Minimal limb outline shader for the cartographic H3 globe frame (no decorative clouds/glow).
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

function hudToken(name: string, fallback: string): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
    fallback
  );
}
