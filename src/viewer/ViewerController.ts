import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { fitCameraToObject } from "./fitCamera";
import { EDGES_TAG, MESH_TAG } from "./StepToThree";

const TRANSPARENT_OPACITY = 0.35;
const MEASURE_COLOR = 0xff5500;
const HOVER_EMISSIVE = 0x2b6cff;
const HOVER_INTENSITY = 0.55;
// A click that moves less than this many pixels is a pick, not an orbit drag.
const CLICK_MOVE_THRESHOLD = 5;

/** Details of the part currently under the cursor, for the info panel + tree. */
export interface PartInfo {
  object: THREE.Object3D;
  name: string;
  triangles: number;
  size: { x: number; y: number; z: number };
}

interface SavedEmissive {
  mat: THREE.MeshStandardMaterial;
  emissive: number;
  intensity: number;
}

/**
 * Owns the three.js scene, camera, controls and render loop for one view
 * (design doc §7.2).
 *
 * `dispose()` is mandatory: without `renderer.dispose()` + `forceContextLoss()`
 * and geometry/material disposal, repeatedly opening views exhausts the
 * browser's small pool of WebGL contexts (design doc §2.6, §7.2).
 */
export class ViewerController {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private ro: ResizeObserver;
  private raf = 0;
  private model: THREE.Group | null = null;
  private disposed = false;

  private wireframe = false;
  private edgesVisible = true;
  private transparent = false;

  // Meshes eligible for hover/measurement raycasting (edges excluded).
  private pickables: THREE.Mesh[] = [];
  private raycaster = new THREE.Raycaster();

  // Hover highlight + part info.
  private hovered: THREE.Mesh | null = null;
  private hoverSaved: SavedEmissive[] = [];
  private pointerNdc = new THREE.Vector2();
  private hoverPending = false;
  private dragging = false;
  /** Called with the hovered part, or null when nothing is under the cursor. */
  onHover: ((info: PartInfo | null) => void) | null = null;

  /** Called once per frame after rendering (used to drive the view cube). */
  onFrame: (() => void) | null = null;
  /** Extra resources (e.g. the view cube) torn down with this controller. */
  private disposables: Array<{ dispose(): void }> = [];

  // Measurement state (design doc §1: results are approximate — mesh, not B-rep).
  private measureEnabled = false;
  private snapEnabled = false;
  private measureGroup = new THREE.Group();
  private measurePoints: THREE.Vector3[] = [];
  private markerRadius = 1;
  private snapThreshold = 1;
  /** Called with the current measurement readout, or null to clear it. */
  onMeasureUpdate: ((text: string | null) => void) | null = null;

  private pointerDownX = 0;
  private pointerDownY = 0;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.domElement.classList.add("step-viewer-canvas");
    host.appendChild(this.renderer.domElement);

    this.scene.background = null; // let CSS theme background show through
    this.scene.add(this.measureGroup);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e6);
    this.camera.position.set(1, 1, 1);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const dir = new THREE.DirectionalLight(0xffffff, 1.2);
    dir.position.set(1, 1, 1);
    this.scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0xffffff, 0.5);
    dir2.position.set(-1, -0.5, -1);
    this.scene.add(dir2);

    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("pointerleave", this.onPointerLeave);

    // Obsidian resizes leaves without firing window.resize; observe the host.
    this.ro = new ResizeObserver(() => this.onResize());
    this.ro.observe(host);
    this.onResize();
    this.animate();
  }

  setModel(group: THREE.Group): void {
    if (this.disposed) {
      this.disposeGroup(group);
      return;
    }
    this.setHover(null); // drop refs into the old model before disposing it
    this.clearMeasurement();
    if (this.model) {
      this.scene.remove(this.model);
      this.disposeGroup(this.model);
    }
    this.model = group;

    this.pickables = [];
    group.traverse((o) => {
      if ((o as THREE.Mesh).userData?.[MESH_TAG]) this.pickables.push(o as THREE.Mesh);
    });

    const box = new THREE.Box3().setFromObject(group);
    const diag = box.isEmpty() ? 1 : box.getSize(new THREE.Vector3()).length();
    this.markerRadius = Math.max(diag * 0.006, 1e-4);
    this.snapThreshold = this.markerRadius * 4;

    this.applyWireframe();
    this.applyEdgesVisibility();
    this.applyTransparency();
    this.scene.add(group);
    fitCameraToObject(this.camera, this.controls, group);
  }

  resetCamera(): void {
    if (this.model) fitCameraToObject(this.camera, this.controls, this.model);
  }

  /** Frame a specific object (used when a structure-tree node is clicked). */
  focusObject(object: THREE.Object3D): void {
    fitCameraToObject(this.camera, this.controls, object);
  }

  getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  getTarget(): THREE.Vector3 {
    return this.controls.target.clone();
  }

  /** Register a resource to dispose when this controller is disposed. */
  registerDisposable(d: { dispose(): void }): void {
    this.disposables.push(d);
  }

  /**
   * Snap the camera to look along `dir` (from the target towards the camera),
   * keeping the current distance. Used by the view cube's standard views.
   */
  setViewDirection(dir: THREE.Vector3): void {
    const target = this.controls.target;
    const dist = this.camera.position.distanceTo(target) || 1;
    // Avoid a degenerate up vector when looking straight down/up.
    const up =
      Math.abs(dir.y) > 0.99
        ? new THREE.Vector3(0, 0, 1)
        : new THREE.Vector3(0, 1, 0);
    this.camera.up.copy(up);
    this.camera.position.copy(target).addScaledVector(dir, dist);
    this.camera.lookAt(target);
    this.controls.update();
  }

  toggleWireframe(): boolean {
    this.wireframe = !this.wireframe;
    this.applyWireframe();
    return this.wireframe;
  }

  toggleEdges(): boolean {
    this.edgesVisible = !this.edgesVisible;
    this.applyEdgesVisibility();
    return this.edgesVisible;
  }

  toggleTransparency(): boolean {
    this.transparent = !this.transparent;
    this.applyTransparency();
    return this.transparent;
  }

  /** Enable/disable measurement pick mode. Disabling clears the current line. */
  toggleMeasure(): boolean {
    this.measureEnabled = !this.measureEnabled;
    this.host.toggleClass("is-measuring", this.measureEnabled);
    if (this.measureEnabled) {
      this.setHover(null); // hover highlight is suppressed while measuring
      this.onMeasureUpdate?.("Click two points on the model");
    } else {
      this.clearMeasurement();
    }
    return this.measureEnabled;
  }

  /** Snap measurement picks to the nearest visible corner/edge. */
  toggleSnap(): boolean {
    this.snapEnabled = !this.snapEnabled;
    return this.snapEnabled;
  }

  isWireframe(): boolean {
    return this.wireframe;
  }
  isEdgesVisible(): boolean {
    return this.edgesVisible;
  }
  isTransparent(): boolean {
    return this.transparent;
  }
  isMeasuring(): boolean {
    return this.measureEnabled;
  }
  isSnapping(): boolean {
    return this.snapEnabled;
  }

  private eachMeshMaterial(fn: (m: THREE.Material) => void): void {
    if (!this.model) return;
    this.model.traverse((o) => {
      if (!(o as THREE.Mesh).userData?.[MESH_TAG]) return;
      const material = (o as THREE.Mesh).material;
      for (const m of Array.isArray(material) ? material : [material]) {
        if (m) fn(m);
      }
    });
  }

  private applyWireframe(): void {
    this.eachMeshMaterial((m) => {
      if ("wireframe" in m) (m as THREE.MeshStandardMaterial).wireframe = this.wireframe;
    });
  }

  private applyEdgesVisibility(): void {
    if (!this.model) return;
    this.model.traverse((o) => {
      if (o.userData?.[EDGES_TAG]) o.visible = this.edgesVisible;
    });
  }

  private applyTransparency(): void {
    this.eachMeshMaterial((m) => {
      m.transparent = this.transparent;
      m.opacity = this.transparent ? TRANSPARENT_OPACITY : 1;
      m.depthWrite = !this.transparent;
      m.needsUpdate = true;
    });
  }

  // --- Hover highlight -----------------------------------------------------

  private onPointerMove = (e: PointerEvent): void => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.hoverPending = true;
  };

  private onPointerLeave = (): void => {
    if (!this.measureEnabled) this.setHover(null);
    this.hoverPending = false;
  };

  private processHover(): void {
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickables, false);
    this.setHover((hits[0]?.object as THREE.Mesh) ?? null);
  }

  private setHover(mesh: THREE.Mesh | null): void {
    if (mesh === this.hovered) return;

    // Restore the previously highlighted materials.
    for (const s of this.hoverSaved) {
      s.mat.emissive.setHex(s.emissive);
      s.mat.emissiveIntensity = s.intensity;
    }
    this.hoverSaved = [];
    this.hovered = mesh;

    if (!mesh) {
      this.onHover?.(null);
      return;
    }

    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const sm = m as THREE.MeshStandardMaterial;
      if (sm && sm.emissive) {
        this.hoverSaved.push({
          mat: sm,
          emissive: sm.emissive.getHex(),
          intensity: sm.emissiveIntensity ?? 1,
        });
        sm.emissive.setHex(HOVER_EMISSIVE);
        sm.emissiveIntensity = HOVER_INTENSITY;
      }
    }

    this.onHover?.(this.describePart(mesh));
  }

  private describePart(mesh: THREE.Mesh): PartInfo {
    const box = new THREE.Box3().setFromObject(mesh);
    const size = box.getSize(new THREE.Vector3());
    const index = mesh.geometry.getIndex();
    const posCount = mesh.geometry.getAttribute("position")?.count ?? 0;
    const triangles = index ? index.count / 3 : posCount / 3;
    return {
      object: mesh,
      name: mesh.name,
      triangles: Math.round(triangles),
      size: { x: size.x, y: size.y, z: size.z },
    };
  }

  // --- Measurement ---------------------------------------------------------

  private onPointerDown = (e: PointerEvent): void => {
    this.pointerDownX = e.clientX;
    this.pointerDownY = e.clientY;
    this.dragging = true;
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.dragging = false;
    if (!this.measureEnabled || e.button !== 0) return;
    const moved = Math.hypot(e.clientX - this.pointerDownX, e.clientY - this.pointerDownY);
    if (moved > CLICK_MOVE_THRESHOLD) return; // it was an orbit drag, not a pick
    this.pickMeasurePoint(e);
  };

  private pickMeasurePoint(e: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickables, false);
    if (hits.length === 0) return;

    // A completed A–B pair starts fresh on the next click.
    if (this.measurePoints.length >= 2) this.clearMeasurement(true);

    let point = hits[0].point.clone();
    let snapped = false;
    if (this.snapEnabled) {
      const s = this.snapPoint(hits[0].object as THREE.Mesh, point);
      if (s) {
        point = s;
        snapped = true;
      }
    }
    this.measurePoints.push(point);
    this.addMarker(point);

    if (this.measurePoints.length === 2) {
      this.drawMeasureLine();
      const dist = this.measurePoints[0].distanceTo(this.measurePoints[1]);
      this.onMeasureUpdate?.(`≈ ${formatMm(dist)} (approx.)`);
    } else {
      this.onMeasureUpdate?.(
        snapped ? "Snapped — click the second point" : "First point set — click the second point",
      );
    }
  }

  /**
   * Snap `p` to the nearest visible corner or edge of `mesh`, using the
   * feature-edge geometry we already build for display. Corners win over edges
   * when both are within threshold. Returns null if nothing is close enough.
   */
  private snapPoint(mesh: THREE.Mesh, p: THREE.Vector3): THREE.Vector3 | null {
    const edges = mesh.children.find((c) => c.userData?.[EDGES_TAG]) as
      | THREE.LineSegments
      | undefined;
    const pos = edges?.geometry.getAttribute("position") as
      | THREE.BufferAttribute
      | undefined;
    if (!pos) return null;

    mesh.updateWorldMatrix(true, false);
    const mw = mesh.matrixWorld;

    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const closest = new THREE.Vector3();
    const seg = new THREE.Line3();

    let bestCorner: THREE.Vector3 | null = null;
    let bestCornerDist = Infinity;
    let bestEdge: THREE.Vector3 | null = null;
    let bestEdgeDist = Infinity;

    for (let i = 0; i < pos.count; i += 2) {
      a.fromBufferAttribute(pos, i).applyMatrix4(mw);
      b.fromBufferAttribute(pos, i + 1).applyMatrix4(mw);

      for (const v of [a, b]) {
        const d = v.distanceTo(p);
        if (d < bestCornerDist) {
          bestCornerDist = d;
          bestCorner = v.clone();
        }
      }

      seg.set(a, b);
      seg.closestPointToPoint(p, true, closest);
      const d = closest.distanceTo(p);
      if (d < bestEdgeDist) {
        bestEdgeDist = d;
        bestEdge = closest.clone();
      }
    }

    if (bestCorner && bestCornerDist <= this.snapThreshold) return bestCorner;
    if (bestEdge && bestEdgeDist <= this.snapThreshold) return bestEdge;
    return null;
  }

  private addMarker(p: THREE.Vector3): void {
    const geom = new THREE.SphereGeometry(this.markerRadius, 16, 12);
    const mat = new THREE.MeshBasicMaterial({ color: MEASURE_COLOR });
    const sphere = new THREE.Mesh(geom, mat);
    sphere.position.copy(p);
    this.measureGroup.add(sphere);
  }

  private drawMeasureLine(): void {
    const geom = new THREE.BufferGeometry().setFromPoints(this.measurePoints);
    const mat = new THREE.LineBasicMaterial({ color: MEASURE_COLOR });
    this.measureGroup.add(new THREE.Line(geom, mat));
  }

  /** Remove markers/line. `keepReadout` avoids clobbering the pick prompt. */
  private clearMeasurement(keepReadout = false): void {
    this.measurePoints = [];
    for (const child of [...this.measureGroup.children]) {
      const m = child as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material;
      if (Array.isArray(mat)) mat.forEach((x) => x?.dispose?.());
      else mat?.dispose?.();
      this.measureGroup.remove(child);
    }
    if (!keepReadout) {
      this.onMeasureUpdate?.(
        this.measureEnabled ? "Click two points on the model" : null,
      );
    }
  }

  private onResize(): void {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private animate = (): void => {
    this.raf = requestAnimationFrame(this.animate);
    this.controls.update();
    // Frame-throttled hover raycasting; suppressed while dragging or measuring.
    if (this.hoverPending && !this.dragging && !this.measureEnabled) {
      this.hoverPending = false;
      this.processHover();
    }
    this.renderer.render(this.scene, this.camera);
    this.onFrame?.();
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controls.dispose();

    const el = this.renderer.domElement;
    el.removeEventListener("pointerdown", this.onPointerDown);
    el.removeEventListener("pointermove", this.onPointerMove);
    el.removeEventListener("pointerup", this.onPointerUp);
    el.removeEventListener("pointerleave", this.onPointerLeave);

    for (const d of this.disposables) d.dispose();
    this.disposables = [];

    this.hoverSaved = [];
    this.hovered = null;
    this.clearMeasurement(true);

    if (this.model) {
      this.scene.remove(this.model);
      this.disposeGroup(this.model);
      this.model = null;
    }
    this.pickables = [];

    this.renderer.dispose();
    this.renderer.forceContextLoss(); // release the WebGL context
    this.renderer.domElement.remove();
  }

  private disposeGroup(g: THREE.Object3D): void {
    g.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const material = mesh.material;
      if (Array.isArray(material)) material.forEach((m) => m?.dispose?.());
      else material?.dispose?.();
    });
    g.parent?.remove(g);
  }
}

/** Format a millimeter distance, switching to metres for large values. */
function formatMm(mm: number): string {
  if (mm >= 1000) return `${(mm / 1000).toFixed(3)} m`;
  return `${mm.toFixed(2)} mm`;
}
