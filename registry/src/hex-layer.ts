import { cellToBoundary } from "h3-js";
import * as THREE from "three";

const DEG_TO_RAD = Math.PI / 180;

/**
 * Static subset of dialtone's HexLayer, adapted for the registry globe.
 * It keeps the same H3 boundary-to-spherical-mesh approach without the
 * animated layers and editor controls used by the main site.
 */
export class HexLayer {
  readonly mesh: THREE.Mesh;

  constructor(
    cells: string[],
    radius: number,
    palette: readonly THREE.Color[],
  ) {
    const positions: number[] = [];
    const colors: number[] = [];

    cells.forEach((cell, index) => {
      const boundary = cellToBoundary(cell, true);
      const tint = palette[index % palette.length];
      const center = boundary
        .reduce(
          (point, [lng, lat]) =>
            point.add(this.latLngToVector(lat, lng, radius)),
          new THREE.Vector3(),
        )
        .divideScalar(boundary.length)
        .normalize()
        .multiplyScalar(radius);

      for (let side = 0; side < boundary.length; side += 1) {
        const [lngA, latA] = boundary[side];
        const [lngB, latB] = boundary[(side + 1) % boundary.length];
        const a = this.latLngToVector(latA, lngA, radius);
        const b = this.latLngToVector(latB, lngB, radius);
        positions.push(
          center.x,
          center.y,
          center.z,
          a.x,
          a.y,
          a.z,
          b.x,
          b.y,
          b.z,
        );
        for (let vertex = 0; vertex < 3; vertex += 1) {
          colors.push(tint.r, tint.g, tint.b);
        }
      }
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    geometry.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(colors, 3),
    );

    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.72,
      vertexColors: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.renderOrder = 1;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }

  private latLngToVector(
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
}
