import * as THREE from "three";
import { OcctMesh, OcctNode, OcctNumberArray, OcctResult } from "../types";

const DEFAULT_COLOR = 0xcccccc;
const EDGE_COLOR = 0x222222;
const EDGE_THRESHOLD_ANGLE = 30; // degrees; hides coplanar-triangle diagonals

/**
 * Above this many triangles we skip the per-mesh edge overlay. `EdgesGeometry`
 * roughly doubles a mesh's geometry memory and CPU, which on a large model (the
 * kind that already strains memory) is the difference between opening and not.
 */
const EDGE_TRIANGLE_BUDGET = 1_500_000;

/** userData flags used by ViewerController to toggle features. */
export const MESH_TAG = "step-mesh";
export const EDGES_TAG = "step-edges";

/** A node in the assembly structure tree, mirroring the THREE object graph. */
export interface StepTreeNode {
  name: string;
  object: THREE.Object3D; // the Group (assembly node) or Mesh (leaf part)
  children: StepTreeNode[];
}

export interface StepModel {
  group: THREE.Group; // add this to the scene
  tree: StepTreeNode; // drives the structure-tree panel
}

/**
 * Convert an occt-import-js result into a THREE object graph plus a parallel
 * structure tree (design doc §7.1; assembly hierarchy from `result.root`).
 *
 * Each assembly node becomes a THREE.Group; each occt mesh becomes a THREE.Mesh
 * with a BufferGeometry. Per-face colors (from `brep_faces`) are represented as
 * geometry groups + a material array. Edges are attached as a child LineSegments
 * so they can be toggled.
 *
 * The caller owns the returned group and must dispose it via
 * ViewerController.disposeGroup when done.
 */
/**
 * True if the parse produced at least one mesh with usable geometry (positions
 * + indices). A large model that overflows the WASM parser can come back
 * "successful" but empty, or with meshes that carry no arrays — callers use this
 * to show a clear error instead of mounting a blank viewer.
 */
export function hasRenderableMeshes(result: OcctResult): boolean {
  return (result.meshes ?? []).some(
    (m) =>
      (m.attributes?.position?.array?.length ?? 0) > 0 &&
      (m.index?.array?.length ?? 0) > 0,
  );
}

export function stepToThree(result: OcctResult): StepModel {
  const root: OcctNode =
    result.root ?? { name: "Model", meshes: [], children: [] };

  // Fallback: some exports put every mesh directly in result.meshes with an
  // empty hierarchy. In that case, attach all meshes to the root so the tree
  // still lists them.
  const rootHasContent =
    root.meshes.length > 0 || (root.children?.length ?? 0) > 0;
  const effectiveRoot: OcctNode = rootHasContent
    ? root
    : { ...root, meshes: result.meshes.map((_, i) => i) };

  // Building the edge overlay per mesh is expensive; skip it wholesale on very
  // large models so they still open (the edges toggle simply has nothing to show).
  const withEdges = totalTriangles(result.meshes) <= EDGE_TRIANGLE_BUDGET;

  const tree = buildNode(effectiveRoot, result.meshes, "Model", withEdges);
  const group = tree.object as THREE.Group;
  group.name = "step-model";
  return { group, tree };
}

/** Total triangle count across all meshes (index length / 3). */
function totalTriangles(meshes: OcctMesh[]): number {
  let n = 0;
  for (const m of meshes ?? []) n += (m.index?.array?.length ?? 0) / 3;
  return n;
}

function buildNode(
  node: OcctNode,
  meshes: OcctMesh[],
  fallbackName: string,
  withEdges: boolean,
): StepTreeNode {
  const group = new THREE.Group();
  group.name = node.name || fallbackName;

  const children: StepTreeNode[] = [];

  for (const meshIndex of node.meshes ?? []) {
    const occtMesh = meshes[meshIndex];
    if (!occtMesh) continue;
    const built = buildMesh(occtMesh, withEdges);
    if (!built) continue;
    group.add(built);
    children.push({
      name: built.name,
      object: built,
      children: [],
    });
  }

  for (const child of node.children ?? []) {
    const childNode = buildNode(child, meshes, "Part", withEdges);
    group.add(childNode.object);
    children.push(childNode);
  }

  return { name: group.name, object: group, children };
}

function buildMesh(mesh: OcctMesh, withEdges: boolean): THREE.Mesh | null {
  const positions = mesh.attributes?.position?.array;
  const indices = mesh.index?.array;
  if (!positions || positions.length === 0 || !indices || indices.length === 0) {
    return null;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(asFloat32(positions), 3),
  );

  // Use the parser's per-vertex normals only when they are present, the right
  // length, AND finite. Some large planar faces come back with NaN/Inf normals;
  // three.js does not warn about those (its NaN check only covers positions via
  // computeBoundingSphere), but a NaN normal makes the lighting term NaN so the
  // whole surface renders as nothing — the mesh looks see-through while its edge
  // overlay (which ignores normals) still shows. Fall back to computed normals
  // in that case so the surface is drawn.
  const normals = mesh.attributes?.normal?.array;
  const normalsUsable =
    !!normals && normals.length === positions.length && allFinite(normals);
  if (normalsUsable) {
    geometry.setAttribute(
      "normal",
      new THREE.Float32BufferAttribute(asFloat32(normals), 3),
    );
  }

  geometry.setIndex(new THREE.BufferAttribute(indexArray(indices), 1));

  if (!normalsUsable) {
    if (normals && normals.length === positions.length) {
      console.warn(
        `[step-viewer] mesh "${mesh.name ?? "?"}": parser normals were ` +
          `invalid (NaN/Inf or zero-length) — recomputing them so the ` +
          `surface renders.`,
      );
    }
    geometry.computeVertexNormals();
  }

  const material = buildMaterials(mesh, geometry);

  const threeMesh = new THREE.Mesh(geometry, material);
  threeMesh.name = mesh.name || "mesh";
  threeMesh.userData[MESH_TAG] = true;

  // Edges as a toggleable child (design doc §7.1) — skipped on huge models.
  if (withEdges) {
    const edgesGeom = new THREE.EdgesGeometry(geometry, EDGE_THRESHOLD_ANGLE);
    const edgesMat = new THREE.LineBasicMaterial({ color: EDGE_COLOR });
    const edges = new THREE.LineSegments(edgesGeom, edgesMat);
    edges.name = "edges";
    edges.userData[EDGES_TAG] = true;
    // Raycasting for measurement must ignore edge lines; only meshes are picked.
    edges.raycast = () => {};
    threeMesh.add(edges);
  }

  return threeMesh;
}

/**
 * Build the mesh material(s). If `brep_faces` carry per-face colors, we split
 * the geometry into groups and return a material array; otherwise a single
 * MeshStandardMaterial (mesh color or default).
 */
function buildMaterials(
  mesh: OcctMesh,
  geometry: THREE.BufferGeometry,
): THREE.Material | THREE.Material[] {
  const faces = mesh.brep_faces;
  const hasFaceColors =
    Array.isArray(faces) && faces.some((f) => f.color != null);

  if (!hasFaceColors) {
    return standardMaterial(mesh.color);
  }

  const materials: THREE.Material[] = [];
  geometry.clearGroups();

  // Total triangles in the mesh (index length / 3). Three.js only draws
  // triangles that lie inside a geometry group, so every triangle must be
  // covered by exactly one group — otherwise it silently vanishes while the
  // edge overlay (EdgesGeometry, which ignores groups) still renders. Large
  // solids sometimes come back with brep_faces that don't tile the whole
  // range, which is why a box's walls can disappear but its edges remain.
  const triCount = (geometry.getIndex()?.count ?? 0) / 3;

  // `faces` is narrowed to a non-empty array here: hasFaceColors is a const
  // whose truthiness implies Array.isArray(faces). Sort by start triangle so
  // we can detect and backfill any gaps between/around the face segments.
  const sorted = [...faces].sort((a, b) => a.first - b.first);

  // Lazily create the shared default-color material used to fill any triangle
  // range not claimed by a brep_face segment.
  let fillerIndex = -1;
  const fillerMaterialIndex = (): number => {
    if (fillerIndex === -1) {
      fillerIndex = materials.length;
      materials.push(standardMaterial(mesh.color));
    }
    return fillerIndex;
  };
  const addTriGroup = (firstTri: number, lastTri: number, materialIndex: number): void => {
    if (lastTri < firstTri) return;
    geometry.addGroup(firstTri * 3, (lastTri - firstTri + 1) * 3, materialIndex);
  };

  let cursor = 0; // first not-yet-covered triangle
  let gapTris = 0; // triangles rescued from uncovered ranges (diagnostics)
  for (const face of sorted) {
    // Clamp the segment to the valid triangle range; drop empty/invalid ones.
    const first = Math.max(0, Math.min(face.first, triCount - 1));
    const last = Math.max(first, Math.min(face.last, triCount - 1));

    // Backfill any gap before this face so those triangles still render.
    if (first > cursor) {
      gapTris += first - cursor;
      addTriGroup(cursor, first - 1, fillerMaterialIndex());
    }

    const materialIndex = materials.length;
    materials.push(standardMaterial(face.color ?? mesh.color));
    addTriGroup(first, last, materialIndex);

    cursor = Math.max(cursor, last + 1);
  }

  // Backfill any trailing triangles past the last face segment.
  if (cursor < triCount) {
    gapTris += triCount - cursor;
    addTriGroup(cursor, triCount - 1, fillerMaterialIndex());
  }

  if (gapTris > 0) {
    console.warn(
      `[step-viewer] mesh "${mesh.name ?? "?"}": brep_faces covered only ` +
        `${triCount - gapTris}/${triCount} triangles; ${gapTris} were not ` +
        `assigned a face segment and would have been invisible — backfilled ` +
        `with the mesh's default color.`,
    );
  }

  return materials;
}

function standardMaterial(
  color?: [number, number, number] | null,
): THREE.MeshStandardMaterial {
  const c = color
    ? new THREE.Color(color[0], color[1], color[2])
    : new THREE.Color(DEFAULT_COLOR);
  return new THREE.MeshStandardMaterial({
    color: c,
    metalness: 0.1,
    roughness: 0.7,
    side: THREE.DoubleSide,
    flatShading: false,
  });
}

/** Use the occt buffer as a Float32Array, avoiding a copy if it already is one. */
function asFloat32(a: OcctNumberArray): Float32Array {
  return a instanceof Float32Array ? a : new Float32Array(a);
}

/**
 * True if every normal vector is finite AND has a usable (non-zero) length.
 * A NaN/Inf component, or a zero-length (0,0,0) normal, both become NaN after
 * the shader normalizes them, which makes the lit surface disappear — so either
 * disqualifies the parser normals and forces a recompute.
 */
function allFinite(a: OcctNumberArray): boolean {
  const MIN_LEN_SQ = 1e-10;
  for (let i = 0; i + 2 < a.length; i += 3) {
    const x = a[i];
    const y = a[i + 1];
    const z = a[i + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return false;
    }
    if (x * x + y * y + z * z < MIN_LEN_SQ) return false;
  }
  return true;
}

/**
 * Choose an index buffer. When the parse ran in the worker the indices already
 * arrive as a typed array (Uint32Array), which we use as-is; otherwise we pick
 * the smallest type that fits the max vertex index.
 */
function indexArray(indices: OcctNumberArray): Uint16Array | Uint32Array {
  if (indices instanceof Uint32Array || indices instanceof Uint16Array) {
    return indices;
  }
  let max = 0;
  for (const i of indices) if (i > max) max = i;
  return max > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
}
