import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { fitCameraToObject } from "./fitCamera";
import { EDGES_TAG, MESH_TAG } from "./StepToThree";

const TRANSPARENT_OPACITY = 0.35;
const MEASURE_COLOR = 0xff5500;
// A click that moves less than this many pixels is a pick, not an orbit drag.
const CLICK_MOVE_THRESHOLD = 5;

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

  // Meshes eligible for measurement raycasting (edges excluded).
  private pickables: THREE.Mesh[] = [];

  // Measurement state (design doc §1: results are approximate — mesh, not B-rep).
  private measureEnabled = false;
  private measureGroup = new THREE.Group();
  private measurePoints: THREE.Vector3[] = [];
  private markerRadius = 1;
  private raycaster = new THREE.Raycaster();
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

    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.addEventListener("pointerup", this.onPointerUp);

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
    if (this.model) {
      this.scene.remove(this.model);
      this.disposeGroup(this.model);
    }
    this.clearMeasurement();
    this.model = group;

    this.pickables = [];
    group.traverse((o) => {
      if ((o as THREE.Mesh).userData?.[MESH_TAG]) this.pickables.push(o as THREE.Mesh);
    });

    const box = new THREE.Box3().setFromObject(group);
    const diag = box.isEmpty()
      ? 1
      : box.getSize(new THREE.Vector3()).length();
    this.markerRadius = Math.max(diag * 0.006, 1e-4);

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
    if (!this.measureEnabled) {
      this.clearMeasurement();
    } else {
      this.onMeasureUpdate?.("Click two points on the model");
    }
    return this.measureEnabled;
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

  // --- Measurement ---------------------------------------------------------

  private onPointerDown = (e: PointerEvent): void => {
    this.pointerDownX = e.clientX;
    this.pointerDownY = e.clientY;
  };

  private onPointerUp = (e: PointerEvent): void => {
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

    const point = hits[0].point.clone();
    this.measurePoints.push(point);
    this.addMarker(point);

    if (this.measurePoints.length === 2) {
      this.drawMeasureLine();
      const dist = this.measurePoints[0].distanceTo(this.measurePoints[1]);
      this.onMeasureUpdate?.(`≈ ${formatMm(dist)} (approx.)`);
    } else {
      this.onMeasureUpdate?.("First point set — click the second point");
    }
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
    if (!keepReadout) this.onMeasureUpdate?.(this.measureEnabled ? "Click two points on the model" : null);
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
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controls.dispose();
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.removeEventListener("pointerup", this.onPointerUp);

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
