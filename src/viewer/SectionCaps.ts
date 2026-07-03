import * as THREE from "three";
import { MESH_TAG } from "./StepToThree";

/**
 * Fills the section-plane cross-section with a hatched cap so cut solids read as
 * solid (not hollow), using the standard stencil technique (three.js
 * `webgl_clipping_stencil`):
 *
 *  - For every model mesh we add two invisible stencil meshes (front / back
 *    faces) that write the stencil buffer where the kept side of the clip plane
 *    is. Back faces increment, front faces decrement, so the buffer is non-zero
 *    exactly across the interior opened by the cut.
 *  - A single large plane, aligned to the clip plane and drawn only where the
 *    stencil ≠ 0, paints the cap. Its material carries a diagonal hatch texture.
 *
 * The stencil meshes are children of the model meshes, so they follow rolls /
 * explode automatically and share geometry (no extra memory for vertices).
 */
export class SectionCaps {
  private capMesh: THREE.Mesh | null = null;
  private stencilMeshes: THREE.Mesh[] = [];
  private texture: THREE.CanvasTexture | null = null;
  private enabled = false;

  constructor(
    private scene: THREE.Scene,
    private plane: THREE.Plane,
  ) {}

  /** Build the stencil meshes (under `model`) and the cap plane (in the scene). */
  build(model: THREE.Group, diag: number): void {
    this.dispose();

    let skipped = 0;
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.userData?.[MESH_TAG]) return;
      // The stencil technique (back faces +1 / front faces −1 ⇒ non-zero inside
      // the solid) only yields a correct "inside" mask for watertight meshes.
      // An open shell (STEP `OPEN_SHELL`, sheet-metal panels, parts occt fails
      // to tessellate fully) has boundary edges, so a ray leaves the shell
      // through one unmatched face and the stencil never returns to zero — the
      // hatch then floods the whole shell's silhouette as a "shadow" instead of
      // just its cut cross-section. Skip such meshes; their cut stays open
      // (uncapped) rather than veiling the view.
      if (!isWatertight(mesh.geometry)) {
        skipped++;
        return;
      }
      const back = this.stencilMesh(mesh.geometry, THREE.BackSide, THREE.IncrementWrapStencilOp);
      const front = this.stencilMesh(mesh.geometry, THREE.FrontSide, THREE.DecrementWrapStencilOp);
      back.visible = this.enabled;
      front.visible = this.enabled;
      mesh.add(back, front);
      this.stencilMeshes.push(back, front);
    });
    if (skipped > 0) {
      console.info(
        `[STEP Viewer] section cap: skipped ${skipped} non-watertight mesh(es) ` +
          `(open shells / parts with missing faces) to keep the hatch from flooding.`,
      );
    }

    // The cut cross-section is bounded by the model's diagonal (a plane through
    // the bounding sphere spans at most its diameter), so size the cap to just
    // cover that — a hair over the diagonal. A much larger plane (the old 3×
    // diagonal) needlessly blankets the viewport, so any stencil imperfection
    // reads as "the whole plane is hatched" instead of only the cut solids.
    const size = Math.max(diag * 1.3, 1);
    this.texture = makeHatchTexture();
    const spacing = Math.max(diag * 0.02, 1e-4);
    const repeat = Math.min(Math.max(size / spacing, 4), 400);
    this.texture.repeat.set(repeat, repeat);

    const capMat = new THREE.MeshStandardMaterial({
      color: 0xcfcfcf,
      metalness: 0.0,
      roughness: 0.9,
      side: THREE.DoubleSide,
      map: this.texture,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      stencilWrite: true,
      stencilRef: 0,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.ReplaceStencilOp,
      stencilZFail: THREE.ReplaceStencilOp,
      stencilZPass: THREE.ReplaceStencilOp,
    });
    this.capMesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), capMat);
    this.capMesh.renderOrder = 2;
    this.capMesh.visible = this.enabled;
    this.capMesh.raycast = () => {};
    // Reset the stencil buffer after the cap so it doesn't leak to later frames.
    this.capMesh.onAfterRender = (renderer) => renderer.clearStencil();
    this.scene.add(this.capMesh);
  }

  private stencilMesh(
    geom: THREE.BufferGeometry,
    side: THREE.Side,
    op: THREE.StencilOp,
  ): THREE.Mesh {
    const mat = new THREE.MeshBasicMaterial();
    mat.depthWrite = false;
    mat.depthTest = false;
    mat.colorWrite = false;
    mat.stencilWrite = true;
    mat.stencilFunc = THREE.AlwaysStencilFunc;
    mat.side = side;
    mat.clippingPlanes = [this.plane];
    mat.stencilFail = op;
    mat.stencilZFail = op;
    mat.stencilZPass = op;
    const m = new THREE.Mesh(geom, mat);
    m.renderOrder = 1;
    m.raycast = () => {};
    return m;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    for (const m of this.stencilMeshes) m.visible = on;
    if (this.capMesh) this.capMesh.visible = on;
  }

  /** Orient the cap plane onto the clip plane, centred near `center`. */
  update(center: THREE.Vector3): void {
    if (!this.capMesh) return;
    const n = this.plane.normal;
    const dist = this.plane.distanceToPoint(center);
    this.capMesh.position.copy(center).addScaledVector(n, -dist);
    this.capMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  }

  dispose(): void {
    for (const m of this.stencilMeshes) {
      m.parent?.remove(m);
      (m.material as THREE.Material).dispose();
    }
    this.stencilMeshes = [];
    if (this.capMesh) {
      this.scene.remove(this.capMesh);
      this.capMesh.geometry.dispose();
      (this.capMesh.material as THREE.Material).dispose();
      this.capMesh = null;
    }
    this.texture?.dispose();
    this.texture = null;
  }
}

/**
 * A tiled diagonal-hatch texture for the cut cap.
 */
function makeHatchTexture(): THREE.CanvasTexture {
  const c = activeDocument.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#c8c8c8";
  ctx.fillRect(0, 0, 64, 64);
  ctx.strokeStyle = "#6a6a6a";
  ctx.lineWidth = 6;
  for (let i = -64; i < 64; i += 16) {
    ctx.beginPath();
    ctx.moveTo(i, 64);
    ctx.lineTo(i + 64, 0);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/**
 * True if `geom` is a closed manifold (every undirected edge shared by exactly
 * two triangles). The stencil cap relies on this: it reads as "inside the
 * solid" only when back-face and front-face counts cancel out across paired
 * triangles, which requires a watertight surface. Open shells (boundary edges)
 * never return to zero and flood the hatch across the whole silhouette.
 *
 * Vertices are welded by rounded position first, because some tessellators
 * (occt-import-js among them) can emit the same coordinate at multiple indices,
 * which would otherwise split shared edges into boundary edges (false negative).
 * Gated at a triangle cap so the per-mesh cost stays bounded on large
 * assemblies; above it we assume watertight (huge solids are virtually always
 * closed, and the alternative — a multi-second edge scan — stalls model load).
 */
const WATERTIGHT_TRIANGLE_CAP = 200_000;
function isWatertight(geom: THREE.BufferGeometry): boolean {
  const idx = geom.getIndex();
  const pos = geom.getAttribute("position");
  if (!idx || !pos) return false;
  const triCount = idx.count / 3;
  if (triCount < 4) return false; // a tetrahedron is the smallest closed solid
  if (triCount > WATERTIGHT_TRIANGLE_CAP) return true;

  // Weld vertices by rounded position → canonical integer id per coordinate.
  const map = new Map<string, number>();
  const welded = new Int32Array(idx.count);
  let nextId = 0;
  const v = new THREE.Vector3();
  for (let t = 0; t < idx.count; t++) {
    v.fromBufferAttribute(pos, idx.getX(t));
    const k = `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
    let id = map.get(k);
    if (id === undefined) {
      id = nextId++;
      map.set(k, id);
    }
    welded[t] = id;
  }

  // Count undirected edges (canonical pair order) across all triangles.
  const count = new Map<number, number>();
  const pair = (a: number, b: number): number =>
    (a < b ? a : b) * 1000003 + (a < b ? b : a);
  for (let t = 0; t < idx.count; t += 3) {
    const a = welded[t], b = welded[t + 1], c = welded[t + 2];
    for (let e = 0; e < 3; e++) {
      const u = e === 0 ? a : e === 1 ? b : c;
      const w = e === 0 ? b : e === 1 ? c : a;
      const k = pair(u, w);
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }

  // Watertight ⇔ every edge is shared by exactly two triangles. Any boundary
  // (count 1) or non-manifold (>2) edge makes the stencil flood.
  for (const n of count.values()) {
    if (n !== 2) return false;
  }
  return true;
}
