import * as THREE from "three";
import { MESH_TAG, EDGES_TAG } from "./StepToThree";

/**
 * In-viewer repair for the "hollow frame" failure mode.
 *
 * Some STEP files describe planar faces the geometry kernel can't tessellate,
 * so those faces come back with no interior triangles — only the part's thin
 * rim is meshed and you see straight through it (occt-import-js does no shape
 * healing). We can reconstruct the missing planar faces from the mesh alone:
 * the rim's open edges form closed boundary loops that lie in the face's plane,
 * so we group boundary loops by plane and re-triangulate each plane (largest
 * loop = outer contour, the rest = holes, so bolt holes/cutouts are preserved).
 *
 * This only ever runs on meshes already detected as frame-like (effectively
 * invisible), so a repaired-but-imperfect fill is strictly better than nothing;
 * well-formed meshes are never touched.
 */

const EDGE_THRESHOLD_ANGLE = 30;
const EDGE_COLOR = 0x222222;

/** A frame-like mesh: triangulated area far below its bounding-box face. */
function isFrameLike(geom: THREE.BufferGeometry): boolean {
  const pos = geom.getAttribute("position");
  const idx = geom.getIndex();
  if (!pos || !idx || idx.count < 3) return false;

  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  let area = 0;
  for (let t = 0; t < idx.count; t += 3) {
    a.fromBufferAttribute(pos, idx.getX(t));
    b.fromBufferAttribute(pos, idx.getX(t + 1));
    c.fromBufferAttribute(pos, idx.getX(t + 2));
    area += ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() * 0.5;
  }
  geom.computeBoundingBox();
  if (!geom.boundingBox) return false;
  const s = new THREE.Vector3();
  geom.boundingBox.getSize(s);
  const dims = [s.x, s.y, s.z].sort((x, y) => y - x);
  const bigFace = dims[0] * dims[1];
  return bigFace > 2500 && area < 0.2 * bigFace;
}

/** Weld triangles by rounded position so boundary detection is meaningful. */
function weld(pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, idx: THREE.BufferAttribute) {
  const map = new Map<string, number>();
  const pts: THREE.Vector3[] = [];
  const tris: [number, number, number][] = [];
  const v = new THREE.Vector3();
  const local = (i: number): number => {
    v.fromBufferAttribute(pos, i);
    const k = `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
    let j = map.get(k);
    if (j === undefined) { j = pts.length; pts.push(v.clone()); map.set(k, j); }
    return j;
  };
  for (let t = 0; t < idx.count; t += 3) {
    tris.push([local(idx.getX(t)), local(idx.getX(t + 1)), local(idx.getX(t + 2))]);
  }
  return { pts, tris };
}

/** Chain the mesh's open (boundary) edges into closed loops. */
function boundaryLoops(tris: [number, number, number][]): number[][] {
  const count = new Map<string, number>();
  const next = new Map<number, number>();
  const ek = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  for (const [a, b, c] of tris)
    for (const [u, w] of [[a, b], [b, c], [c, a]]) count.set(ek(u, w), (count.get(ek(u, w)) ?? 0) + 1);
  for (const [a, b, c] of tris)
    for (const [u, w] of [[a, b], [b, c], [c, a]]) if (count.get(ek(u, w)) === 1) next.set(u, w);

  const loops: number[][] = [];
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: number[] = [];
    let u: number | undefined = start;
    let guard = 0;
    while (u !== undefined && !seen.has(u) && guard++ < 100000) {
      seen.add(u);
      loop.push(u);
      u = next.get(u);
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

function newellNormal(pts: THREE.Vector3[], loop: number[]): THREE.Vector3 {
  const n = new THREE.Vector3();
  for (let i = 0; i < loop.length; i++) {
    const a = pts[loop[i]], b = pts[loop[(i + 1) % loop.length]];
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  }
  return n.lengthSq() > 0 ? n.normalize() : new THREE.Vector3(0, 0, 1);
}

/**
 * Flip a normal into a canonical hemisphere so a face's outer contour and its
 * (oppositely wound) hole loops land in the same plane group — otherwise holes
 * become their own group and get capped solid, filling bolt/connector holes.
 */
function canonicalNormal(n: THREE.Vector3): THREE.Vector3 {
  const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
  let s: number;
  if (az >= ax && az >= ay) s = Math.sign(n.z) || 1;
  else if (ay >= ax) s = Math.sign(n.y) || 1;
  else s = Math.sign(n.x) || 1;
  return n.clone().multiplyScalar(s);
}

function loopArea(pts: THREE.Vector3[], loop: number[], n: THREE.Vector3): number {
  const acc = new THREE.Vector3();
  const cx = new THREE.Vector3();
  for (let i = 0; i < loop.length; i++) {
    acc.add(cx.crossVectors(pts[loop[i]], pts[loop[(i + 1) % loop.length]]));
  }
  return Math.abs(0.5 * acc.dot(n));
}

/** Triangulate one plane's loops (largest = outer, rest = holes) → world tris. */
function capPlane(pts: THREE.Vector3[], loops: number[][], n: THREE.Vector3): number[] {
  const up = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const ex = new THREE.Vector3().crossVectors(n, up).normalize();
  const ey = new THREE.Vector3().crossVectors(n, ex).normalize();
  const to2 = (i: number) => new THREE.Vector2(pts[i].dot(ex), pts[i].dot(ey));

  const withArea = loops
    .map((l) => ({ l, a: loopArea(pts, l, n) }))
    .sort((p, q) => q.a - p.a);
  if (withArea.length === 0 || withArea[0].a < 100) return [];

  const outer = withArea[0].l.map(to2);
  const holes = withArea.slice(1).map((w) => w.l.map(to2));
  const flat = [...withArea[0].l, ...withArea.slice(1).flatMap((w) => w.l)];
  const faces = THREE.ShapeUtils.triangulateShape(outer, holes);

  const out: number[] = [];
  for (const f of faces) {
    for (const k of f) {
      const p = pts[flat[k]];
      out.push(p.x, p.y, p.z);
    }
  }
  return out;
}

/** Reconstruct missing planar faces of one frame-like mesh, in place. */
function healMesh(mesh: THREE.Mesh): boolean {
  const geom = mesh.geometry;
  const pos = geom.getAttribute("position");
  const idx = geom.getIndex();
  if (!pos || !idx) return false;

  const { pts, tris } = weld(pos, idx);
  const loops = boundaryLoops(tris);
  if (loops.length === 0) return false;

  // Group loops by plane (quantised normal + offset).
  const groups = new Map<string, { n: THREE.Vector3; loops: number[][] }>();
  for (const loop of loops) {
    const n = canonicalNormal(newellNormal(pts, loop));
    const off = pts[loop[0]].dot(n);
    const key = `${Math.round(n.x * 20)},${Math.round(n.y * 20)},${Math.round(n.z * 20)}|${Math.round(off * 10)}`;
    let g = groups.get(key);
    if (!g) { g = { n, loops: [] }; groups.set(key, g); }
    g.loops.push(loop);
  }

  const capVerts: number[] = [];
  for (const { n, loops: ls } of groups.values()) {
    try {
      capVerts.push(...capPlane(pts, ls, n));
    } catch {
      /* skip a plane whose loops don't triangulate cleanly */
    }
  }
  if (capVerts.length === 0) return false;

  // Rebuild geometry as original triangles (de-indexed) + the new cap triangles.
  const orig: number[] = [];
  const v = new THREE.Vector3();
  for (let t = 0; t < idx.count; t++) {
    v.fromBufferAttribute(pos, idx.getX(t));
    orig.push(v.x, v.y, v.z);
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.Float32BufferAttribute([...orig, ...capVerts], 3));
  merged.computeVertexNormals();

  mesh.geometry.dispose();
  mesh.geometry = merged;

  // Rebuild the edge overlay from the repaired geometry.
  const oldEdges = mesh.children.find((c) => c.userData?.[EDGES_TAG]);
  if (oldEdges) {
    mesh.remove(oldEdges);
    (oldEdges as THREE.LineSegments).geometry.dispose();
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(merged, EDGE_THRESHOLD_ANGLE),
      new THREE.LineBasicMaterial({ color: EDGE_COLOR }),
    );
    edges.name = "edges";
    edges.userData[EDGES_TAG] = true;
    edges.raycast = () => {};
    mesh.add(edges);
  }
  return true;
}

/**
 * Repair every frame-like mesh under `group`. Returns the names of meshes that
 * were repaired. Only single-material meshes are touched (per-face-coloured
 * meshes keep geometry groups we must not disturb; the affected sheet-metal
 * panels are single-material).
 */
export function healFrameLikeMeshes(group: THREE.Object3D): string[] {
  const healed: string[] = [];
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.userData?.[MESH_TAG] || Array.isArray(mesh.material)) return;
    if (!isFrameLike(mesh.geometry)) return;
    if (healMesh(mesh)) healed.push(mesh.name || "mesh");
  });
  return healed;
}
