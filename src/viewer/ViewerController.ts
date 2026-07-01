import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { fitCameraToObject } from "./fitCamera";
import { EDGES_TAG, MESH_TAG } from "./StepToThree";

const TRANSPARENT_OPACITY = 0.35;
const MEASURE_COLOR = 0xff5500;
const HIGHLIGHT_COLOR = 0xff8a00;
const SNAP_COLOR = 0x22cc66;
const ANNOT_COLOR = 0xffc531;
const AXIS_COLORS = { x: 0xe5484d, y: 0x30a46c, z: 0x3b82f6 };
// A click that moves less than this many pixels is a pick, not an orbit drag.
const CLICK_MOVE_THRESHOLD = 5;
const ROLL_DURATION = 0.28; // seconds

/** Details of the part currently under the cursor, for the info panel + tree. */
export interface PartInfo {
  object: THREE.Object3D;
  name: string;
  triangles: number;
  size: { x: number; y: number; z: number };
}

/** A measurement number label to render as an HTML overlay at `pos`. */
export interface MeasureLabel {
  pos: THREE.Vector3;
  text: string;
  color: number;
}

/** Where the user clicked in annotate mode. `local` is in model space. */
export interface AnnotatePick {
  local: THREE.Vector3;
  part: string;
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

  // Hover highlight + part info. The highlight is a translucent overlay mesh
  // (sharing the hovered geometry) so it reads on any base colour — an emissive
  // tint is swamped on light/already-bright materials.
  private hovered: THREE.Mesh | null = null;
  private highlightMesh: THREE.Mesh | null = null;
  private highlightMat: THREE.MeshBasicMaterial | null = null;
  private pointerNdc = new THREE.Vector2();
  private hoverPending = false;
  private dragging = false;
  /** Called with the hovered part, or null when nothing is under the cursor. */
  onHover: ((info: PartInfo | null) => void) | null = null;

  /** Called each frame after rendering (drives the view cube + label overlays). */
  private frameCallbacks: Array<() => void> = [];
  /** Extra resources (e.g. the view cube) torn down with this controller. */
  private disposables: Array<{ dispose(): void }> = [];
  private clock = new THREE.Clock();

  // Measurement state (design doc §1: results are approximate — mesh, not B-rep).
  private measureEnabled = false;
  private snapEnabled = false;
  private measureGroup = new THREE.Group();
  private previewGroup = new THREE.Group();
  private previewMesh: THREE.Mesh | null = null;
  private measurePoints: THREE.Vector3[] = [];
  private markerRadius = 1;
  private snapThreshold = 1;
  /** Called with the current measurement readout, or null to clear it. */
  onMeasureUpdate: ((text: string | null) => void) | null = null;
  /** Called with the measurement number labels (empty array to clear them). */
  onMeasureLabels: ((labels: MeasureLabel[]) => void) | null = null;

  // Annotation pick mode.
  private annotateEnabled = false;
  /** Called when the user clicks a point in annotate mode. */
  onAnnotate: ((pick: AnnotatePick) => void) | null = null;

  // 90° roll animation.
  private roll = {
    active: false,
    t: 0,
    startPos: new THREE.Vector3(),
    endPos: new THREE.Vector3(),
    startQuat: new THREE.Quaternion(),
    endQuat: new THREE.Quaternion(),
  };

  private pointerDownX = 0;
  private pointerDownY = 0;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.domElement.classList.add("step-viewer-canvas");
    host.appendChild(this.renderer.domElement);

    this.scene.background = null; // let CSS theme background show through
    this.scene.add(this.measureGroup);
    this.scene.add(this.previewGroup);

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
    this.disposePreview();
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

  getDomElement(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  getModel(): THREE.Group | null {
    return this.model;
  }

  /** World position for a point expressed in model-local space. */
  localToWorld(local: THREE.Vector3): THREE.Vector3 {
    return this.model ? this.model.localToWorld(local.clone()) : local.clone();
  }

  /** Register a resource to dispose when this controller is disposed. */
  registerDisposable(d: { dispose(): void }): void {
    this.disposables.push(d);
  }

  /** Register a per-frame callback (runs after render). */
  registerFrameCallback(fn: () => void): void {
    this.frameCallbacks.push(fn);
  }

  /**
   * Add a pin marker at a model-local point (child of the model group so it
   * follows rolls). Returns the object for later removal.
   */
  addAnnotationPin(local: THREE.Vector3): THREE.Object3D {
    const geom = new THREE.SphereGeometry(this.markerRadius, 16, 12);
    const mat = new THREE.MeshBasicMaterial({ color: ANNOT_COLOR });
    const pin = new THREE.Mesh(geom, mat);
    pin.position.copy(local);
    pin.raycast = () => {};
    this.model?.add(pin);
    return pin;
  }

  removeAnnotationPin(pin: THREE.Object3D): void {
    pin.parent?.remove(pin);
    const m = pin as THREE.Mesh;
    m.geometry?.dispose?.();
    const mat = m.material;
    if (Array.isArray(mat)) mat.forEach((x) => x?.dispose?.());
    else mat?.dispose?.();
  }

  /**
   * Snap the camera to look along `dir` (from the target towards the camera),
   * keeping the current distance. Used by the view cube's standard views.
   *
   * We deliberately leave `camera.up` at world-Y and let OrbitControls orient
   * the camera via `update()`. OrbitControls computes its pole axis from the
   * up vector *once*, so changing `camera.up` here would desync it and make
   * mouse control break after a top/bottom (upside-down) view. `update()` also
   * clamps the polar angle away from the exact pole, so straight up/down is safe.
   */
  setViewDirection(dir: THREE.Vector3): void {
    const target = this.controls.target;
    const dist = this.camera.position.distanceTo(target) || 1;
    this.camera.position.copy(target).addScaledVector(dir.clone().normalize(), dist);
    this.controls.update();
  }

  /**
   * Roll the model 90° about the current view axis (the ↶ / ↷ arrows).
   * We rotate the model, not the camera: OrbitControls owns the camera up and
   * doesn't support roll, so rolling the camera would desync it.
   */
  rollView(sign: 1 | -1): void {
    if (!this.model) return;
    const axis = new THREE.Vector3();
    this.camera.getWorldDirection(axis); // view direction, in world space
    const pivot = this.controls.target.clone();
    const q = new THREE.Quaternion().setFromAxisAngle(axis, (sign * Math.PI) / 2);

    // Compute the target transform, then tween to it (animate, don't jump).
    const endPos = this.model.position.clone().sub(pivot).applyQuaternion(q).add(pivot);
    const endQuat = q.clone().multiply(this.model.quaternion);

    this.roll.active = true;
    this.roll.t = 0;
    this.roll.startPos.copy(this.model.position);
    this.roll.endPos.copy(endPos);
    this.roll.startQuat.copy(this.model.quaternion);
    this.roll.endQuat.copy(endQuat);

    // Markers/preview are world-anchored and would drift from the geometry.
    this.setHover(null);
    this.clearMeasurement();
    this.setPreview(null, false);
  }

  private advanceRoll(dt: number): void {
    if (!this.roll.active || !this.model) return;
    this.roll.t = Math.min(this.roll.t + dt / ROLL_DURATION, 1);
    const e = easeInOut(this.roll.t);
    this.model.position.lerpVectors(this.roll.startPos, this.roll.endPos, e);
    this.model.quaternion.copy(this.roll.startQuat).slerp(this.roll.endQuat, e);
    if (this.roll.t >= 1) this.roll.active = false;
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
    if (this.measureEnabled && this.annotateEnabled) this.setAnnotate(false);
    this.host.toggleClass("is-measuring", this.measureEnabled);
    if (this.measureEnabled) {
      this.setHover(null); // hover highlight is suppressed while measuring
      this.onMeasureUpdate?.("Click two points on the model");
    } else {
      this.clearMeasurement();
      this.setPreview(null, false);
    }
    return this.measureEnabled;
  }

  /** Enable/disable annotate mode (click a point to pin a note). */
  toggleAnnotate(): boolean {
    this.setAnnotate(!this.annotateEnabled);
    return this.annotateEnabled;
  }

  private setAnnotate(on: boolean): void {
    this.annotateEnabled = on;
    if (on && this.measureEnabled) this.toggleMeasure();
    this.host.toggleClass("is-annotating", on);
    if (on) this.setHover(null);
    else this.setPreview(null, false);
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
  isAnnotating(): boolean {
    return this.annotateEnabled;
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
    if (this.measureEnabled || this.annotateEnabled) this.setPreview(null, false);
    else this.setHover(null);
    this.hoverPending = false;
  };

  private processHover(): void {
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickables, false);
    this.setHover((hits[0]?.object as THREE.Mesh) ?? null);
  }

  private setHover(mesh: THREE.Mesh | null): void {
    if (mesh === this.hovered) return;
    this.clearHighlight();
    this.hovered = mesh;

    if (!mesh) {
      this.onHover?.(null);
      return;
    }

    // Overlay a translucent copy that shares the geometry. polygonOffset pulls
    // it slightly forward to avoid z-fighting with the original surface.
    this.highlightMat = new THREE.MeshBasicMaterial({
      color: HIGHLIGHT_COLOR,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.highlightMesh = new THREE.Mesh(mesh.geometry, this.highlightMat);
    this.highlightMesh.renderOrder = 2;
    this.highlightMesh.raycast = () => {}; // never pickable
    mesh.add(this.highlightMesh);

    this.onHover?.(this.describePart(mesh));
  }

  /** Remove the hover overlay (never disposes the shared geometry). */
  private clearHighlight(): void {
    if (this.highlightMesh) {
      this.highlightMesh.parent?.remove(this.highlightMesh);
      this.highlightMesh = null;
    }
    this.highlightMat?.dispose();
    this.highlightMat = null;
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
    if (e.button !== 0) return;
    if (!this.measureEnabled && !this.annotateEnabled) return;
    const moved = Math.hypot(e.clientX - this.pointerDownX, e.clientY - this.pointerDownY);
    if (moved > CLICK_MOVE_THRESHOLD) return; // it was an orbit drag, not a pick
    if (this.measureEnabled) this.pickMeasurePoint(e);
    else this.pickAnnotate(e);
  };

  private pickAnnotate(e: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    // Reuse the measurement resolver so the snap toggle applies here too.
    const resolved = this.raycastResolve(ndc);
    if (!resolved || !this.model) return;
    const local = this.model.worldToLocal(resolved.point.clone());
    this.onAnnotate?.({ local, part: resolved.object.name });
  }

  private pickMeasurePoint(e: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const resolved = this.raycastResolve(ndc);
    if (!resolved) return;

    // A completed A–B pair starts fresh on the next click.
    if (this.measurePoints.length >= 2) this.clearMeasurement(true);

    this.measurePoints.push(resolved.point);
    this.addMarker(resolved.point);

    if (this.measurePoints.length === 2) {
      const [a, b] = this.measurePoints;
      this.drawMeasureLine(a, b);
      const dist = a.distanceTo(b);
      const dx = Math.abs(b.x - a.x);
      const dy = Math.abs(b.y - a.y);
      const dz = Math.abs(b.z - a.z);
      this.onMeasureUpdate?.(
        `≈ ${formatMm(dist)} (approx.)  ·  Δ ${num(dx)} / ${num(dy)} / ${num(dz)} mm (X/Y/Z)`,
      );
      // Number labels beside each segment (main + axis legs).
      const c1 = new THREE.Vector3(b.x, a.y, a.z);
      const c2 = new THREE.Vector3(b.x, b.y, a.z);
      const labels: MeasureLabel[] = [
        { pos: mid(a, b), text: formatMm(dist), color: MEASURE_COLOR },
      ];
      if (dx > 1e-6) labels.push({ pos: mid(a, c1), text: `${num(dx)} mm`, color: AXIS_COLORS.x });
      if (dy > 1e-6) labels.push({ pos: mid(c1, c2), text: `${num(dy)} mm`, color: AXIS_COLORS.y });
      if (dz > 1e-6) labels.push({ pos: mid(c2, b), text: `${num(dz)} mm`, color: AXIS_COLORS.z });
      this.onMeasureLabels?.(labels);
    } else {
      this.onMeasureUpdate?.(
        resolved.snapped
          ? "Snapped — click the second point"
          : "First point set — click the second point",
      );
    }
  }

  /** Raycast at `ndc` and resolve the hit to a (possibly snapped) point. */
  private raycastResolve(
    ndc: THREE.Vector2,
  ): { point: THREE.Vector3; snapped: boolean; object: THREE.Object3D } | null {
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickables, false);
    if (hits.length === 0) return null;
    const object = hits[0].object;
    let point = hits[0].point.clone();
    let snapped = false;
    if (this.snapEnabled) {
      const s = this.snapPoint(object as THREE.Mesh, point);
      if (s) {
        point = s;
        snapped = true;
      }
    }
    return { point, snapped, object };
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

  private drawMeasureLine(a: THREE.Vector3, b: THREE.Vector3): void {
    // Direct A–B line.
    this.addLeg(a, b, MEASURE_COLOR);
    // Axis-aligned legs showing the X / Y / Z components of the span.
    const c1 = new THREE.Vector3(b.x, a.y, a.z);
    const c2 = new THREE.Vector3(b.x, b.y, a.z);
    this.addLeg(a, c1, AXIS_COLORS.x);
    this.addLeg(c1, c2, AXIS_COLORS.y);
    this.addLeg(c2, b, AXIS_COLORS.z);
  }

  private addLeg(a: THREE.Vector3, b: THREE.Vector3, color: number): void {
    const geom = new THREE.BufferGeometry().setFromPoints([a, b]);
    const mat = new THREE.LineBasicMaterial({ color });
    this.measureGroup.add(new THREE.Line(geom, mat));
  }

  // --- Measurement snap preview -------------------------------------------

  private updateMeasurePreview(): void {
    const resolved = this.raycastResolve(this.pointerNdc);
    this.setPreview(resolved?.point ?? null, resolved?.snapped ?? false);
  }

  private setPreview(point: THREE.Vector3 | null, snapped: boolean): void {
    if (!point) {
      if (this.previewMesh) this.previewMesh.visible = false;
      return;
    }
    if (!this.previewMesh) {
      // Unit sphere; scaled per frame so it keeps a constant on-screen size.
      const geom = new THREE.SphereGeometry(1, 16, 12);
      const mat = new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.55, // a bit see-through so it doesn't hide the target
        depthTest: false, // always visible, even behind surfaces
      });
      this.previewMesh = new THREE.Mesh(geom, mat);
      this.previewMesh.renderOrder = 3;
      this.previewGroup.add(this.previewMesh);
    }
    (this.previewMesh.material as THREE.MeshBasicMaterial).color.setHex(
      snapped ? SNAP_COLOR : MEASURE_COLOR,
    );
    this.previewMesh.position.copy(point);
    this.previewMesh.visible = true;
    this.rescalePreview();
  }

  /** Scale the preview by camera distance so it stays a constant screen size. */
  private rescalePreview(): void {
    if (!this.previewMesh?.visible) return;
    const dist = this.camera.position.distanceTo(this.previewMesh.position);
    this.previewMesh.scale.setScalar(Math.max(dist * 0.012, 1e-4));
  }

  private disposePreview(): void {
    if (!this.previewMesh) return;
    this.previewMesh.geometry.dispose();
    (this.previewMesh.material as THREE.Material).dispose();
    this.previewGroup.remove(this.previewMesh);
    this.previewMesh = null;
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
    this.onMeasureLabels?.([]);
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
    const dt = this.clock.getDelta();
    this.advanceRoll(dt);
    this.controls.update();
    // Frame-throttled pointer raycasting; suppressed while dragging (orbit).
    // In measure mode it drives the snap preview; otherwise the hover highlight.
    if (this.hoverPending && !this.dragging) {
      this.hoverPending = false;
      if (this.measureEnabled || this.annotateEnabled) this.updateMeasurePreview();
      else this.processHover();
    }
    this.rescalePreview();
    this.renderer.render(this.scene, this.camera);
    for (const fn of this.frameCallbacks) fn();
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

    this.clearHighlight();
    this.hovered = null;
    this.clearMeasurement(true);
    this.disposePreview();

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

/** Compact unit-less millimetre number for the per-axis components. */
function num(mm: number): string {
  return mm >= 100 ? mm.toFixed(0) : mm.toFixed(1);
}

function mid(a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 {
  return a.clone().add(b).multiplyScalar(0.5);
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}
