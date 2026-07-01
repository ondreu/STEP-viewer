import * as THREE from "three";
import { OcctMesh, OcctNode, OcctResult } from "../types";

const DEFAULT_COLOR = 0xcccccc;
const EDGE_COLOR = 0x222222;
const EDGE_THRESHOLD_ANGLE = 30; // degrees; hides coplanar-triangle diagonals

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

  const tree = buildNode(effectiveRoot, result.meshes, "Model");
  const group = tree.object as THREE.Group;
  group.name = "step-model";
  return { group, tree };
}

function buildNode(
  node: OcctNode,
  meshes: OcctMesh[],
  fallbackName: string,
): StepTreeNode {
  const group = new THREE.Group();
  group.name = node.name || fallbackName;

  const children: StepTreeNode[] = [];

  for (const meshIndex of node.meshes ?? []) {
    const occtMesh = meshes[meshIndex];
    if (!occtMesh) continue;
    const built = buildMesh(occtMesh);
    if (!built) continue;
    group.add(built);
    children.push({
      name: built.name,
      object: built,
      children: [],
    });
  }

  for (const child of node.children ?? []) {
    const childNode = buildNode(child, meshes, "Part");
    group.add(childNode.object);
    children.push(childNode);
  }

  return { name: group.name, object: group, children };
}

function buildMesh(mesh: OcctMesh): THREE.Mesh | null {
  const positions = mesh.attributes?.position?.array;
  const indices = mesh.index?.array;
  if (!positions || positions.length === 0 || !indices || indices.length === 0) {
    return null;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(new Float32Array(positions), 3),
  );

  const normals = mesh.attributes?.normal?.array;
  if (normals && normals.length === positions.length) {
    geometry.setAttribute(
      "normal",
      new THREE.Float32BufferAttribute(new Float32Array(normals), 3),
    );
  }

  geometry.setIndex(new THREE.BufferAttribute(indexArray(indices), 1));

  if (!normals || normals.length !== positions.length) {
    geometry.computeVertexNormals();
  }

  const material = buildMaterials(mesh, geometry);

  const threeMesh = new THREE.Mesh(geometry, material);
  threeMesh.name = mesh.name || "mesh";
  threeMesh.userData[MESH_TAG] = true;

  // Edges as a toggleable child (design doc §7.1).
  const edgesGeom = new THREE.EdgesGeometry(geometry, EDGE_THRESHOLD_ANGLE);
  const edgesMat = new THREE.LineBasicMaterial({ color: EDGE_COLOR });
  const edges = new THREE.LineSegments(edgesGeom, edgesMat);
  edges.name = "edges";
  edges.userData[EDGES_TAG] = true;
  // Raycasting for measurement must ignore edge lines; only meshes are picked.
  edges.raycast = () => {};
  threeMesh.add(edges);

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

  // faces! is safe here: hasFaceColors implies faces is a non-empty array.
  for (const face of faces as NonNullable<typeof faces>) {
    const materialIndex = materials.length;
    materials.push(standardMaterial(face.color ?? mesh.color));
    // brep_faces index triangles; a triangle spans 3 indices.
    const start = face.first * 3;
    const count = (face.last - face.first + 1) * 3;
    geometry.addGroup(start, count, materialIndex);
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

/** Choose the smallest index type that fits the vertex count. */
function indexArray(indices: number[]): Uint16Array | Uint32Array {
  let max = 0;
  for (const i of indices) if (i > max) max = i;
  return max > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
}
