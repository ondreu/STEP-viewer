import * as THREE from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { createRenderMesh, StepModel, StepTreeNode } from "./StepToThree";

/**
 * Loaders for plain triangle-mesh formats (OBJ, STL). Unlike STEP these carry
 * no BREP — just triangles — so there is no shape-healing question and no
 * per-face colours; each object becomes one viewer-ready mesh. The output
 * matches stepToThree's shape (a Group + a parallel structure tree) so the rest
 * of the viewer (tree, hover/select, edges, section, measurement) is identical.
 */

// Above this many triangles, skip the per-mesh edge overlay (see StepToThree).
const EDGE_TRIANGLE_BUDGET = 1_500_000;

function triCount(geom: THREE.BufferGeometry): number {
  const idx = geom.getIndex();
  return (idx ? idx.count : geom.getAttribute("position")?.count ?? 0) / 3;
}

/** Convert a parsed three.js object graph into a viewer StepModel. */
function wrap(root: THREE.Object3D, fallbackName: string): StepModel {
  // Collect the geometries the loader produced (OBJLoader returns a Group of
  // Meshes; STLLoader returns a single BufferGeometry handled by the caller).
  const sourceMeshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) sourceMeshes.push(o as THREE.Mesh);
  });

  const total = sourceMeshes.reduce((n, m) => n + triCount(m.geometry), 0);
  const withEdges = total <= EDGE_TRIANGLE_BUDGET;

  const group = new THREE.Group();
  group.name = "step-model";
  const children: StepTreeNode[] = [];

  sourceMeshes.forEach((src, i) => {
    const geom = src.geometry.index
      ? src.geometry
      : src.geometry.toNonIndexed();
    // Bake the loader's transform into the geometry so world coords are correct.
    src.updateWorldMatrix(true, false);
    geom.applyMatrix4(src.matrixWorld);
    const name = src.name || `${fallbackName}${sourceMeshes.length > 1 ? " " + (i + 1) : ""}`;
    const mesh = createRenderMesh(geom, name, withEdges);
    group.add(mesh);
    children.push({ name: mesh.name, object: mesh, children: [] });
  });

  const tree: StepTreeNode = { name: fallbackName, object: group, children };
  return { group, tree };
}

/** Parse a Wavefront OBJ (text) into a StepModel. */
export function objToStepModel(text: string, name: string): StepModel {
  const obj = new OBJLoader().parse(text);
  return wrap(obj, name);
}

/** Parse an STL (ASCII or binary) into a StepModel. */
export function stlToStepModel(data: ArrayBuffer, name: string): StepModel {
  const geom = new STLLoader().parse(data);
  const mesh = new THREE.Mesh(geom);
  mesh.name = name;
  return wrap(mesh, name);
}
