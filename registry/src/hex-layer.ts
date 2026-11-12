import { cellToBoundary } from "h3-js";
import * as THREE from "three";

const DEG_TO_RAD = Math.PI / 180;

/**
 * Static subset of dialtone's HexLayer, adapted for the registry globe.
 * It keeps the same H3 boundary-to-spherical-mesh approach without the
 * animated layers and editor controls used by the main site.
 */
export class HexLayer {
  readonly group = new THREE.Group();
  private readonly surface: THREE.Mesh;
  private readonly outlines: THREE.LineSegments;

  constructor(cells: string[], radius: number) {
    const positions: number[] = [];
    const outlinePositions: number[] = [];
    const surfaceRadius = radius * 1.002;
    const outlineRadius = radius * 1.003;

    cells.forEach((cell) => {
      const boundary = cellToBoundary(cell, true);
      const surfaceRing: THREE.Vector3[] = [];
      const outlineRing: THREE.Vector3[] = [];
      const center = boundary
        .reduce(
          (point, [lng, lat]) => {
            const surfacePoint = this.latLngToVector(
              lat,
              lng,
              surfaceRadius,
            );
            surfaceRing.push(surfacePoint);
            outlineRing.push(
              this.latLngToVector(lat, lng, outlineRadius),
            );
            return point.add(surfacePoint);
          },
          new THREE.Vector3(),
        )
        .divideScalar(boundary.length)
        .normalize()
        .multiplyScalar(surfaceRadius);

      for (let side = 0; side < boundary.length; side += 1) {
        const a = surfaceRing[side];
        const b = surfaceRing[(side + 1) % surfaceRing.length];
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
        const outlineA = outlineRing[side];
        const outlineB = outlineRing[(side + 1) % outlineRing.length];
        outlinePositions.push(
          outlineA.x,
          outlineA.y,
          outlineA.z,
          outlineB.x,
          outlineB.y,
          outlineB.z,
        );
      }
    });

    const surfaceGeometry = new THREE.BufferGeometry();
    surfaceGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(positions, 3),
    );
    surfaceGeometry.computeVertexNormals();
    const outlineGeometry = new THREE.BufferGeometry();
    outlineGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(outlinePositions, 3),
    );

    this.surface = new THREE.Mesh(
      surfaceGeometry,
      new THREE.MeshBasicMaterial({
        color: 0xececec,
        transparent: true,
        opacity: 0.08,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      }),
    );
    this.outlines = new THREE.LineSegments(
      outlineGeometry,
      new THREE.LineBasicMaterial({
        color: 0x9c9c9c,
        transparent: true,
        opacity: 0.46,
      }),
    );
    this.surface.renderOrder = 1;
    this.outlines.renderOrder = 2;
    this.group.add(this.surface, this.outlines);
  }

  dispose(): void {
    this.surface.geometry.dispose();
    (this.surface.material as THREE.Material).dispose();
    this.outlines.geometry.dispose();
    (this.outlines.material as THREE.Material).dispose();
  }

  private latLngToVector(
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
}
