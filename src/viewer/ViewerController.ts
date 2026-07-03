import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { fitCameraToObject } from "./fitCamera";
import { EDGES_TAG, MESH_TAG } from "./StepToThree";
import { SectionCaps } from "./SectionCaps";

const TRANSPARENT_OPACITY = 0.35;
const MEASURE_COLOR = 0xff5500;
const HIGHLIGHT_COLOR = 0xff8a00;
const SELECT_COLOR = 0x3b82f6;
const SNAP_COLOR = 0x22cc66;
const ANNOT_COLOR = 0xffc531;
const AXIS_COLORS = { x: 0xe5484d, y: 0x30a46c, z: 0x3b82f6 };
// A click that moves less than this many pixels is a pick, not an orbit drag.
const CLICK_MOVE_THRESHOLD = 5;
// Fingers wander more than a mouse, so allow a larger slop for touch taps.
const TOUCH_MOVE_THRESHOLD = 12;
const ROLL_DURATION = 0.28; // seconds
// On-screen size factor for measurement / annotation markers: their world
// radius is set each frame to `distance * MARKER_SCREEN` so they keep a roughly
// constant size regardless of zoom (features: anchors scale with zoom).
const MARKER_SCREEN = 0.008;

// Scratch objects reused by the per-frame marker rescale (avoids allocations).
const _tmpV = new THREE.Vector3();
const _tmpS = new THREE.Vector3();

/** Details of the part currently under the cursor, for the info panel + tree. */
export interface PartInfo {
  object: THREE.Object3D;
  name: string;
  triangles: number;
  size: { x: number; y: number; z: number };
  /** Assembly path from the model root down to this part (names joined). */
  path: string;
  /** Approx. volume (mm³) and surface area (mm²) from the mesh. */
  volume: number;
  area: number;
  /** Surface colour as a #rrggbb string, when the part has a single colour. */
  color?: string;
  /** Material name resolved from the STEP metadata (filled in by mountViewer). */
  material?: string;
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

/** The kind of measurement being taken. */
export type MeasureMode =
  | "distance"
  | "angle"
  | "radius"
  | "thickness"
  | "point-face"
  | "face-face";

/** How many picks each measurement mode needs before it computes a result. */
const MEASURE_PICKS: Record<MeasureMode, number> = {
  distance: 2,
  angle: 3,
  radius: 3,
  thickness: 1,
  "point-face": 2,
  "face-face": 2,
};

/** Initial prompt shown when a measurement mode is selected. */
const MEASURE_PROMPTS: Record<MeasureMode, string> = {
  distance: "Click two points on the model",
  angle: "Click three points — the corner is the 2nd",
  radius: "Click three points around a circular edge",
  thickness: "Click a point on a face",
  "point-face": "Click a face, then any point",
  "face-face": "Click a point on each of two faces",
};

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
  private perspCamera: THREE.PerspectiveCamera;
  private orthoCamera: THREE.OrthographicCamera;
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private orthographic = false;
  private controls: OrbitControls;
  private ro: ResizeObserver;
  private raf = 0;
  private model: THREE.Group | null = null;
  private modelDiag = 1;
  private modelBasePos = new THREE.Vector3();
  private modelBaseQuat = new THREE.Quaternion();
  private disposed = false;

  private wireframe = false;
  private edgesVisible = true;
  private transparent = false;

  // Section (clipping) plane state.
  private sectionEnabled = false;
  private sectionAxis: "x" | "y" | "z" = "x";
  private sectionFlip = false;
  private sectionT = 0.5;
  private sectionPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
  private sectionCaps: SectionCaps | null = null;

  // Explode state: per top-level part, its base local position + outward dir.
  private exploded = 0;
  private explodeParts: { obj: THREE.Object3D; base: THREE.Vector3; dir: THREE.Vector3 }[] = [];

  // Persistent selection highlight + isolate.
  private selected: THREE.Object3D | null = null;
  private selectOverlays: THREE.Mesh[] = [];
  private previewOverlays: THREE.Mesh[] = [];
  private isolated = false;
  private isolateHidden: THREE.Object3D[] = [];
  /** Fired when isolate turns on (with the kept subtree) or off (null), so the
   *  annotation/measurement layers can hide anchors outside the isolated part. */
  onIsolateChange: ((kept: THREE.Object3D | null) => void) | null = null;

  // Markers (measurement + annotation anchor spheres) whose world radius is
  // rescaled each frame so they keep a constant on-screen size (unit geometry).
  private scaleMarkers: THREE.Mesh[] = [];

  // Meshes eligible for hover/measurement raycasting (edges excluded).
  private pickables: THREE.Mesh[] = [];
  private raycaster = new THREE.Raycaster();

  /**
   * Pickables that are actually visible on screen. Three.js raycasting ignores
   * `.visible`, so a mesh hidden via the structure tree would still intercept
   * clicks and hover — including any part sitting behind it. We must exclude a
   * mesh whose own or any ancestor's `.visible` is false before intersecting.
   */
  private visiblePickables(): THREE.Mesh[] {
    return this.pickables.filter((mesh) => {
      let o: THREE.Object3D | null = mesh;
      while (o) {
        if (!o.visible) return false;
        o = o.parent;
      }
      return true;
    });
  }

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
  /** Called when a part is clicked (selected), or null when clicking empty space. */
  onSelectPart: ((info: PartInfo | null) => void) | null = null;

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
  private measureNormals: (THREE.Vector3 | null)[] = [];
  private measureMode: MeasureMode = "distance";
  private markerRadius = 1;
  private snapThreshold = 1;
  /** Called with the current measurement readout, or null to clear it. */
  onMeasureUpdate: ((text: string | null) => void) | null = null;
  /** Called with the measurement number labels (empty array to clear them). */
  onMeasureLabels: ((labels: MeasureLabel[]) => void) | null = null;
  /** Called when a full A–B measurement becomes available (or is cleared), so
   *  the UI can offer to pin it as a persistent measurement. */
  onMeasureCanKeep: ((canKeep: boolean) => void) | null = null;

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

    this.renderer.localClippingEnabled = true; // for the section plane
    this.scene.background = null; // let CSS theme background show through
    this.scene.add(this.measureGroup);
    this.scene.add(this.previewGroup);

    this.perspCamera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e6);
    this.perspCamera.position.set(1, 1, 1);
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.001, 1e6);
    this.orthoCamera.position.set(1, 1, 1);
    this.camera = this.perspCamera;

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
    this.modelBasePos.copy(group.position);
    this.modelBaseQuat.copy(group.quaternion);

    this.pickables = [];
    group.traverse((o) => {
      if ((o as THREE.Mesh).userData?.[MESH_TAG]) this.pickables.push(o as THREE.Mesh);
    });

    this.logMeshDiagnostics();

    const box = new THREE.Box3().setFromObject(group);
    const diag = box.isEmpty() ? 1 : box.getSize(new THREE.Vector3()).length();
    this.modelDiag = diag;
    this.markerRadius = Math.max(diag * 0.006, 1e-4);
    this.snapThreshold = this.markerRadius * 4;

    // Record top-level parts for explode (outward direction from assembly centre).
    this.explodeParts = [];
    this.exploded = 0;
    const center = box.getCenter(new THREE.Vector3());
    for (const child of group.children) {
      const cbox = new THREE.Box3().setFromObject(child);
      if (cbox.isEmpty()) continue;
      const dir = cbox.getCenter(new THREE.Vector3()).sub(center);
      if (dir.lengthSq() < 1e-9) dir.set(0, 1, 0);
      else dir.normalize();
      this.explodeParts.push({ obj: child, base: child.position.clone(), dir });
    }

    this.applyWireframe();
    this.applyEdgesVisibility();
    this.applyTransparency();
    this.applySection();
    if (!this.sectionCaps) this.sectionCaps = new SectionCaps(this.scene, this.sectionPlane);
    this.sectionCaps.build(group, diag);
    this.scene.add(group);
    fitCameraToObject(this.camera, this.controls, group);
  }

  /**
   * One-off diagnostics for the "surfaces missing, only edges render" report.
   * Logs a summary plus the largest meshes (the enclosure panels are the big
   * ones) with the facts that decide the cause: material side, whether the
   * geometry has a finite bounding sphere (NaN → frustum-culled → invisible),
   * group coverage, and a sample normal length (0/NaN → unlit → invisible).
   */
  private logMeshDiagnostics(): void {
    let frontSided = 0;
    let nanSphere = 0;
    const rows: {
      name: string;
      tris: number;
      side: string;
      sphere: string;
      groups: number;
      normLen: string;
    }[] = [];

    for (const mesh of this.pickables) {
      const geom = mesh.geometry;
      const tris = (geom.getIndex()?.count ?? 0) / 3;

      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const side =
        (mat as THREE.Material)?.side === THREE.DoubleSide
          ? "double"
          : (mat as THREE.Material)?.side === THREE.FrontSide
            ? "front"
            : "back";
      if (side !== "double") frontSided++;

      geom.computeBoundingSphere();
      const r = geom.boundingSphere?.radius ?? NaN;
      const sphereOk = Number.isFinite(r);
      if (!sphereOk) nanSphere++;

      const normals = geom.getAttribute("normal");
      let normLen = "none";
      if (normals) {
        const nx = normals.getX(0), ny = normals.getY(0), nz = normals.getZ(0);
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        normLen = Number.isFinite(len) ? len.toFixed(3) : "NaN";
      }

      rows.push({
        name: mesh.name,
        tris: Math.round(tris),
        side,
        sphere: sphereOk ? r.toFixed(1) : "NaN",
        groups: geom.groups.length,
        normLen,
      });
    }

    rows.sort((a, b) => b.tris - a.tris);
    console.info(
      `[STEP Viewer] mesh diagnostics: ${this.pickables.length} meshes, ` +
        `${frontSided} not double-sided, ${nanSphere} with NaN bounding sphere.`,
    );
    console.table(rows.slice(0, 12));
  }

  resetCamera(): void {
    if (this.model) fitCameraToObject(this.camera, this.controls, this.model);
  }

  /** Frame a specific object (used when a structure-tree node is clicked). */
  focusObject(object: THREE.Object3D): void {
    fitCameraToObject(this.camera, this.controls, object);
  }

  /**
   * Bounding-box dimension segments (world space) for `object`: the three edges
   * from its min corner spanning the X, Y and Z extents. Used by "auto-measure"
   * to add a part's overall L×W×H in one action. Zero-length edges are skipped;
   * returns null when the object has no geometry.
   */
  autoMeasureSegments(object: THREE.Object3D): { a: THREE.Vector3; b: THREE.Vector3 }[] | null {
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return null;
    const { min, max } = box;
    const segs: { a: THREE.Vector3; b: THREE.Vector3 }[] = [];
    const eps = this.modelDiag * 1e-4;
    if (max.x - min.x > eps)
      segs.push({ a: new THREE.Vector3(min.x, min.y, min.z), b: new THREE.Vector3(max.x, min.y, min.z) });
    if (max.y - min.y > eps)
      segs.push({ a: new THREE.Vector3(min.x, min.y, min.z), b: new THREE.Vector3(min.x, max.y, min.z) });
    if (max.z - min.z > eps)
      segs.push({ a: new THREE.Vector3(min.x, min.y, min.z), b: new THREE.Vector3(min.x, min.y, max.z) });
    return segs.length ? segs : null;
  }

  /** Pan the camera so `worldPoint` is centred, keeping the current zoom. */
  lookAtPoint(worldPoint: THREE.Vector3): void {
    const delta = worldPoint.clone().sub(this.controls.target);
    this.controls.target.add(delta);
    this.camera.position.add(delta);
    this.controls.update();
  }

  getCamera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
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

  /** Model-local position for a point expressed in world space. */
  worldToLocal(world: THREE.Vector3): THREE.Vector3 {
    return this.model ? this.model.worldToLocal(world.clone()) : world.clone();
  }

  /**
   * The model's current orientation (its group quaternion). The view cube uses
   * this to stay locked to the *model* frame rather than the world frame, so a
   * 90° roll — which rotates the model, not the camera — rotates the cube too.
   */
  getModelQuaternion(): THREE.Quaternion {
    return this.model ? this.model.quaternion.clone() : new THREE.Quaternion();
  }

  // --- Camera projection ---------------------------------------------------

  /** Switch between perspective and orthographic projection, preserving view. */
  setProjection(ortho: boolean): boolean {
    if (ortho === this.orthographic) return this.orthographic;

    const target = this.controls.target.clone();
    const old = this.camera;
    const offsetVec = old.position.clone().sub(target);
    const dist = offsetVec.length() || 1;
    const dir = offsetVec.clone().normalize();
    const aspect = (this.host.clientWidth || 1) / (this.host.clientHeight || 1);
    const fov = (this.perspCamera.fov * Math.PI) / 180;

    if (ortho) {
      // Match the perspective view's visible height at the target distance.
      const halfV = Math.tan(fov / 2) * dist;
      this.orthoCamera.top = halfV;
      this.orthoCamera.bottom = -halfV;
      this.orthoCamera.left = -halfV * aspect;
      this.orthoCamera.right = halfV * aspect;
      this.orthoCamera.zoom = 1;
      const depth = Math.max(dist, halfV * 4, this.modelDiag * 2);
      this.orthoCamera.position.copy(target).addScaledVector(dir, depth);
      this.orthoCamera.up.copy(old.up);
      this.orthoCamera.near = 0.001;
      this.orthoCamera.far = depth * 100;
      this.orthoCamera.updateProjectionMatrix();
      this.camera = this.orthoCamera;
    } else {
      const halfV = ((this.orthoCamera.top - this.orthoCamera.bottom) / 2) / this.orthoCamera.zoom;
      const dist2 = halfV / Math.tan(fov / 2) || dist;
      this.perspCamera.position.copy(target).addScaledVector(dir, dist2);
      this.perspCamera.up.copy(old.up);
      this.perspCamera.aspect = aspect;
      this.perspCamera.near = Math.max(dist2 / 1000, 0.001);
      this.perspCamera.far = dist2 * 1000;
      this.perspCamera.updateProjectionMatrix();
      this.camera = this.perspCamera;
    }

    this.orthographic = ortho;
    this.rebuildControls(target);
    return this.orthographic;
  }

  toggleProjection(): boolean {
    return this.setProjection(!this.orthographic);
  }

  isOrthographic(): boolean {
    return this.orthographic;
  }

  /** Rebuild OrbitControls for the current active camera (target preserved). */
  private rebuildControls(target: THREE.Vector3): void {
    this.controls.dispose();
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.copy(target);
    this.controls.update();
  }

  // --- Section (clipping) plane -------------------------------------------

  toggleSection(): boolean {
    return this.setSectionEnabled(!this.sectionEnabled);
  }

  setSectionEnabled(on: boolean): boolean {
    this.sectionEnabled = on;
    this.updateSectionPlane();
    this.applySection();
    this.sectionCaps?.setEnabled(on);
    return this.sectionEnabled;
  }

  setSectionAxis(axis: "x" | "y" | "z"): void {
    this.sectionAxis = axis;
    this.updateSectionPlane();
  }

  setSectionPosition(t: number): void {
    this.sectionT = Math.min(Math.max(t, 0), 1);
    this.updateSectionPlane();
  }

  setSectionFlip(flip: boolean): void {
    this.sectionFlip = flip;
    this.updateSectionPlane();
  }

  isSectioning(): boolean {
    return this.sectionEnabled;
  }
  getSectionAxis(): "x" | "y" | "z" {
    return this.sectionAxis;
  }
  isSectionFlipped(): boolean {
    return this.sectionFlip;
  }

  /** Recompute the clip plane from the model's world bounds + slider position. */
  private updateSectionPlane(): void {
    if (!this.model) return;
    const box = new THREE.Box3().setFromObject(this.model);
    if (box.isEmpty()) return;
    const axis = this.sectionAxis;
    const lo = box.min[axis];
    const hi = box.max[axis];
    const pos = lo + (hi - lo) * this.sectionT;
    const n = new THREE.Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0);
    if (this.sectionFlip) n.negate();
    this.sectionPlane.normal.copy(n);
    // distance(p) = n·p + constant, keeps p where distance ≥ 0.
    this.sectionPlane.constant = -(n[axis] * pos);
    this.sectionCaps?.update(box.getCenter(new THREE.Vector3()));
  }

  /** Apply (or clear) the clip plane on model surfaces + edges only. */
  private applySection(): void {
    if (!this.model) return;
    const planes = this.sectionEnabled ? [this.sectionPlane] : [];
    this.model.traverse((o) => {
      if (!(o.userData?.[MESH_TAG] || o.userData?.[EDGES_TAG])) return;
      const material = (o as THREE.Mesh).material;
      for (const m of Array.isArray(material) ? material : [material]) {
        if (!m) continue;
        m.clippingPlanes = planes;
        m.clipShadows = true;
        m.needsUpdate = true;
      }
    });
  }

  // --- Explode -------------------------------------------------------------

  /** True when the model has more than one top-level part to spread apart. */
  isExplodable(): boolean {
    return this.explodeParts.length > 1;
  }

  getExplode(): number {
    return this.exploded;
  }

  /** Spread top-level parts outward from the assembly centre. `amount` 0..1. */
  setExplode(amount: number): void {
    this.exploded = amount;
    const spread = this.modelDiag * amount;
    for (const p of this.explodeParts) {
      p.obj.position.copy(p.base).addScaledVector(p.dir, spread);
    }
  }

  // --- Selection highlight + isolate --------------------------------------

  /** Highlight (persistent overlay) all meshes under `object`, or clear it. */
  setSelected(object: THREE.Object3D | null): void {
    this.clearSelection();
    this.selected = object;
    if (object) {
      object.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.userData?.[MESH_TAG]) return;
        const mat = new THREE.MeshBasicMaterial({
          color: SELECT_COLOR,
          transparent: true,
          opacity: 0.4,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
        });
        const overlay = new THREE.Mesh(mesh.geometry, mat);
        overlay.renderOrder = 2;
        overlay.raycast = () => {};
        mesh.add(overlay);
        this.selectOverlays.push(overlay);
      });
    }
    if (this.isolated) this.applyIsolate();
  }

  getSelected(): THREE.Object3D | null {
    return this.selected;
  }

  /** Transient highlight (e.g. hovering a tree row), separate from selection. */
  previewHighlight(object: THREE.Object3D | null): void {
    for (const o of this.previewOverlays) {
      o.parent?.remove(o);
      (o.material as THREE.Material).dispose();
    }
    this.previewOverlays = [];
    if (!object) return;
    object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.userData?.[MESH_TAG]) return;
      const mat = new THREE.MeshBasicMaterial({
        color: HIGHLIGHT_COLOR,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
      const overlay = new THREE.Mesh(mesh.geometry, mat);
      overlay.renderOrder = 2;
      overlay.raycast = () => {};
      mesh.add(overlay);
      this.previewOverlays.push(overlay);
    });
  }

  private clearSelection(): void {
    for (const overlay of this.selectOverlays) {
      overlay.parent?.remove(overlay);
      (overlay.material as THREE.Material).dispose();
    }
    this.selectOverlays = [];
    this.selected = null;
  }

  toggleIsolate(): boolean {
    this.isolated = !this.isolated;
    this.applyIsolate();
    return this.isolated;
  }

  isIsolated(): boolean {
    return this.isolated;
  }

  /** Hide everything except the selected subtree (restores on disable). */
  private applyIsolate(): void {
    for (const o of this.isolateHidden) o.visible = true;
    this.isolateHidden = [];
    const active = this.isolated && this.selected ? this.selected : null;
    // Let the annotation/measurement layers hide anchors outside the kept part.
    this.onIsolateChange?.(active);
    if (!active || !this.model) return;
    const keep = new Set<THREE.Object3D>();
    active.traverse((o) => keep.add(o));
    let p: THREE.Object3D | null = active;
    while (p) {
      keep.add(p);
      p = p.parent;
    }
    this.model.traverse((o) => {
      if ((o as THREE.Mesh).userData?.[MESH_TAG] && !keep.has(o) && o.visible) {
        o.visible = false;
        this.isolateHidden.push(o);
      }
    });
  }

  // --- Screenshot ----------------------------------------------------------

  /**
   * Render one frame and return it as a PNG data URL. Rendering right before the
   * read keeps the drawing buffer valid without `preserveDrawingBuffer`.
   */
  captureImage(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL("image/png");
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
    const geom = new THREE.SphereGeometry(1, 16, 12); // unit; scaled per frame
    const mat = new THREE.MeshBasicMaterial({ color: ANNOT_COLOR });
    const pin = new THREE.Mesh(geom, mat);
    pin.position.copy(local);
    pin.raycast = () => {};
    this.model?.add(pin);
    this.registerMarker(pin);
    return pin;
  }

  removeAnnotationPin(pin: THREE.Object3D): void {
    this.unregisterMarker(pin as THREE.Mesh);
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

  /** Roll the model `quarters`×90° about the current view axis, without animating
   *  (used to apply an embed's initial rotation). */
  rollInstant(quarters: number): void {
    if (!this.model || !quarters) return;
    const axis = new THREE.Vector3();
    this.camera.getWorldDirection(axis);
    const pivot = this.controls.target.clone();
    const q = new THREE.Quaternion().setFromAxisAngle(axis, (quarters * Math.PI) / 2);
    const endPos = this.model.position.clone().sub(pivot).applyQuaternion(q).add(pivot);
    this.model.position.copy(endPos);
    this.model.quaternion.premultiply(q);
    this.setHover(null);
    this.clearMeasurement();
    this.setPreview(null, false);
    if (this.sectionEnabled) this.updateSectionPlane(); // re-sync world-space cut
  }

  /** Undo any rolls: restore the model's orientation to how it loaded. Used when
   *  snapping to a standard view so the view cube ends up axis-aligned (upright). */
  resetModelOrientation(): void {
    if (!this.model) return;
    this.roll.active = false;
    this.model.position.copy(this.modelBasePos);
    this.model.quaternion.copy(this.modelBaseQuat);
    this.setHover(null);
    this.clearMeasurement();
    this.setPreview(null, false);
    if (this.sectionEnabled) this.updateSectionPlane();
  }

  private advanceRoll(dt: number): void {
    if (!this.roll.active || !this.model) return;
    this.roll.t = Math.min(this.roll.t + dt / ROLL_DURATION, 1);
    const e = easeInOut(this.roll.t);
    this.model.position.lerpVectors(this.roll.startPos, this.roll.endPos, e);
    this.model.quaternion.copy(this.roll.startQuat).slerp(this.roll.endQuat, e);
    if (this.roll.t >= 1) {
      this.roll.active = false;
      // The clip plane is world-space; re-derive it from the rolled bounds.
      if (this.sectionEnabled) this.updateSectionPlane();
    }
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
      this.onMeasureUpdate?.(MEASURE_PROMPTS[this.measureMode]);
    } else {
      this.clearMeasurement();
      this.setPreview(null, false);
    }
    return this.measureEnabled;
  }

  /** Choose the active measurement type (clears any in-progress picks). */
  setMeasureMode(mode: MeasureMode): void {
    this.measureMode = mode;
    this.clearMeasurement();
    if (this.measureEnabled) this.onMeasureUpdate?.(MEASURE_PROMPTS[mode]);
  }

  getMeasureMode(): MeasureMode {
    return this.measureMode;
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
    const hits = this.raycaster.intersectObjects(this.visiblePickables(), false);
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
    const { volume, area } = volumeAndArea(mesh.geometry);
    return {
      object: mesh,
      name: mesh.name,
      triangles: Math.round(triangles),
      size: { x: size.x, y: size.y, z: size.z },
      path: this.partPath(mesh),
      volume,
      area,
      color: meshColor(mesh),
    };
  }

  /** Assembly path (root → part) built from the object's ancestor names. */
  private partPath(mesh: THREE.Object3D): string {
    const names: string[] = [];
    let o: THREE.Object3D | null = mesh;
    while (o && o !== this.model) {
      if (o.name && o.name !== "edges") names.unshift(o.name);
      o = o.parent;
    }
    return names.join(" / ");
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
    const threshold =
      e.pointerType === "touch" ? TOUCH_MOVE_THRESHOLD : CLICK_MOVE_THRESHOLD;
    const moved = Math.hypot(e.clientX - this.pointerDownX, e.clientY - this.pointerDownY);
    if (moved > threshold) return; // it was an orbit drag, not a tap
    if (this.measureEnabled) this.pickMeasurePoint(e);
    else if (this.annotateEnabled) this.pickAnnotate(e);
    // Otherwise a plain click selects the part under the cursor: the highlight
    // sticks (persistent selection) and the structure tree reveals it. Hover
    // (mouse-over) only shows the transient highlight — it never selects.
    else this.pickSelect(e);
  };

  private pickSelect(e: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.visiblePickables(), false)[0];
    const mesh = (hit?.object as THREE.Mesh) ?? null;
    this.setSelected(mesh);
    this.onSelectPart?.(mesh ? this.describePart(mesh) : null);
  }

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

    const need = MEASURE_PICKS[this.measureMode];
    // A completed set starts fresh on the next click.
    if (this.measurePoints.length >= need) this.clearMeasurement(true);

    // Face-based modes require a surface normal on the defining pick.
    const needsNormalFirst =
      this.measureMode === "thickness" ||
      this.measureMode === "point-face" ||
      this.measureMode === "face-face";
    if (needsNormalFirst && this.measurePoints.length === 0 && !resolved.normal) {
      this.onMeasureUpdate?.("Click directly on a face");
      return;
    }

    this.measurePoints.push(resolved.point);
    this.measureNormals.push(resolved.normal);
    this.addMarker(resolved.point);

    if (this.measurePoints.length < need) {
      this.onMeasureUpdate?.(this.progressPrompt(resolved.snapped));
      return;
    }
    this.computeMeasurement();
  }

  private progressPrompt(snapped: boolean): string {
    const got = this.measurePoints.length;
    const need = MEASURE_PICKS[this.measureMode];
    const prefix = snapped ? "Snapped — " : "";
    return `${prefix}${got}/${need} points — ${MEASURE_PROMPTS[this.measureMode]}`;
  }

  /** Dispatch to the per-mode result once enough points are collected. */
  private computeMeasurement(): void {
    switch (this.measureMode) {
      case "distance":
        return this.computeDistance();
      case "angle":
        return this.computeAngle();
      case "radius":
        return this.computeRadius();
      case "thickness":
        return this.computeThickness();
      case "point-face":
        return this.computePointFace();
      case "face-face":
        return this.computeFaceFace();
    }
  }

  private computeDistance(): void {
    const [a, b] = this.measurePoints;
    this.drawMeasureLine(a, b);
    const dist = a.distanceTo(b);
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    const dz = Math.abs(b.z - a.z);
    this.onMeasureUpdate?.(
      `≈ ${formatMm(dist)} (approx.)  ·  Δ ${num(dx)} / ${num(dy)} / ${num(dz)} mm (X/Y/Z)`,
    );
    const c1 = new THREE.Vector3(b.x, a.y, a.z);
    const c2 = new THREE.Vector3(b.x, b.y, a.z);
    const labels: MeasureLabel[] = [
      { pos: mid(a, b), text: formatMm(dist), color: MEASURE_COLOR },
    ];
    if (dx > 1e-6) labels.push({ pos: mid(a, c1), text: `${num(dx)} mm`, color: AXIS_COLORS.x });
    if (dy > 1e-6) labels.push({ pos: mid(c1, c2), text: `${num(dy)} mm`, color: AXIS_COLORS.y });
    if (dz > 1e-6) labels.push({ pos: mid(c2, b), text: `${num(dz)} mm`, color: AXIS_COLORS.z });
    this.onMeasureLabels?.(labels);
    this.onMeasureCanKeep?.(true); // only distance can be pinned persistently
  }

  private computeAngle(): void {
    const [a, v, b] = this.measurePoints;
    this.addLeg(v, a, MEASURE_COLOR);
    this.addLeg(v, b, MEASURE_COLOR);
    const u1 = a.clone().sub(v);
    const u2 = b.clone().sub(v);
    if (u1.lengthSq() < 1e-12 || u2.lengthSq() < 1e-12) {
      this.onMeasureUpdate?.("Points are too close — try again");
      return;
    }
    const deg = THREE.MathUtils.radToDeg(u1.angleTo(u2));
    this.onMeasureUpdate?.(`∠ ≈ ${deg.toFixed(1)}° (approx.)`);
    this.onMeasureLabels?.([{ pos: v, text: `${deg.toFixed(1)}°`, color: MEASURE_COLOR }]);
  }

  private computeRadius(): void {
    const circle = circleFrom3Points(
      this.measurePoints[0],
      this.measurePoints[1],
      this.measurePoints[2],
    );
    if (!circle) {
      this.onMeasureUpdate?.("Those points are collinear — try again");
      return;
    }
    const { center, radius } = circle;
    this.addMarker(center);
    for (const p of this.measurePoints) this.addLeg(center, p, MEASURE_COLOR);
    this.onMeasureUpdate?.(
      `R ≈ ${formatMm(radius)}  ·  ⌀ ≈ ${formatMm(radius * 2)} (approx.)`,
    );
    this.onMeasureLabels?.([
      { pos: mid(center, this.measurePoints[0]), text: `R ${formatMm(radius)}`, color: MEASURE_COLOR },
    ]);
  }

  private computeThickness(): void {
    const p = this.measurePoints[0];
    const n = this.measureNormals[0];
    if (!n) {
      this.onMeasureUpdate?.("Could not read the surface normal — try again");
      return;
    }
    // Shoot a ray into the material (opposite the outward normal) and take the
    // first surface it exits through. A small offset avoids re-hitting the face.
    const inward = n.clone().negate();
    const eps = this.markerRadius * 0.1;
    this.raycaster.set(p.clone().addScaledVector(inward, eps), inward);
    this.raycaster.far = this.modelDiag * 2;
    const hits = this.raycaster
      .intersectObjects(this.visiblePickables(), false)
      .filter((h) => h.distance > eps * 2);
    this.raycaster.far = Infinity; // restore for hover/pick raycasting
    if (hits.length === 0) {
      this.onMeasureUpdate?.("No opposite face found below that point");
      return;
    }
    const far = hits[0].point.clone();
    this.addMarker(far);
    this.addLeg(p, far, MEASURE_COLOR);
    const t = p.distanceTo(far);
    this.onMeasureUpdate?.(`Thickness ≈ ${formatMm(t)} (approx.)`);
    this.onMeasureLabels?.([{ pos: mid(p, far), text: formatMm(t), color: MEASURE_COLOR }]);
  }

  private computePointFace(): void {
    const face = this.measurePoints[0];
    const n = this.measureNormals[0];
    const pt = this.measurePoints[1];
    if (!n) {
      this.onMeasureUpdate?.("First click must be on a face — try again");
      return;
    }
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, face);
    const foot = plane.projectPoint(pt, new THREE.Vector3());
    this.addMarker(foot);
    this.addLeg(pt, foot, MEASURE_COLOR);
    const d = Math.abs(plane.distanceToPoint(pt));
    this.onMeasureUpdate?.(`Point → face ≈ ${formatMm(d)} (perpendicular, approx.)`);
    this.onMeasureLabels?.([{ pos: mid(pt, foot), text: formatMm(d), color: MEASURE_COLOR }]);
  }

  private computeFaceFace(): void {
    const a = this.measurePoints[0];
    const na = this.measureNormals[0];
    const b = this.measurePoints[1];
    if (!na) {
      this.onMeasureUpdate?.("First click must be on a face — try again");
      return;
    }
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(na, a);
    const foot = plane.projectPoint(b, new THREE.Vector3());
    this.addMarker(foot);
    this.addLeg(b, foot, MEASURE_COLOR);
    const d = Math.abs(plane.distanceToPoint(b));
    this.onMeasureUpdate?.(`Face → face ≈ ${formatMm(d)} (along 1st normal, approx.)`);
    this.onMeasureLabels?.([{ pos: mid(b, foot), text: formatMm(d), color: MEASURE_COLOR }]);
  }

  /** Raycast at `ndc` and resolve the hit to a (possibly snapped) point. */
  private raycastResolve(
    ndc: THREE.Vector2,
  ): {
    point: THREE.Vector3;
    snapped: boolean;
    object: THREE.Object3D;
    normal: THREE.Vector3 | null;
  } | null {
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.visiblePickables(), false);
    if (hits.length === 0) return null;
    const hit = hits[0];
    const object = hit.object;
    let point = hit.point.clone();
    let snapped = false;
    if (this.snapEnabled) {
      const s = this.snapPoint(object as THREE.Mesh, point);
      if (s) {
        point = s;
        snapped = true;
      }
    }
    // World-space face normal (used by thickness / face-based measurements).
    let normal: THREE.Vector3 | null = null;
    if (hit.face) {
      normal = hit.face.normal
        .clone()
        .transformDirection(object.matrixWorld)
        .normalize();
    }
    return { point, snapped, object, normal };
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
    const geom = new THREE.SphereGeometry(1, 16, 12); // unit; scaled per frame
    const mat = new THREE.MeshBasicMaterial({ color: MEASURE_COLOR });
    const sphere = new THREE.Mesh(geom, mat);
    sphere.position.copy(p);
    this.measureGroup.add(sphere);
    this.registerMarker(sphere);
  }

  // --- Scalable markers ----------------------------------------------------

  /** Track a unit-sphere marker so it's rescaled to constant screen size. */
  private registerMarker(m: THREE.Mesh): void {
    this.scaleMarkers.push(m);
    this.rescaleMarker(m); // size it correctly on the frame it appears
  }

  private unregisterMarker(m: THREE.Mesh): void {
    const i = this.scaleMarkers.indexOf(m);
    if (i >= 0) this.scaleMarkers.splice(i, 1);
  }

  /** Set one marker's scale so its world radius ≈ distance · MARKER_SCREEN. */
  private rescaleMarker(m: THREE.Mesh): void {
    m.getWorldPosition(_tmpV);
    const dist = this.camera.position.distanceTo(_tmpV) || 1;
    let parentScale = 1;
    if (m.parent) parentScale = m.parent.getWorldScale(_tmpS).x || 1;
    m.scale.setScalar((dist * MARKER_SCREEN) / parentScale);
  }

  private rescaleMarkers(): void {
    for (const m of this.scaleMarkers) this.rescaleMarker(m);
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

  /**
   * Public: return the current completed A–B measurement (world coordinates),
   * or null if fewer than two points are set. Used to pin it persistently.
   */
  getCompletedMeasurement(): { a: THREE.Vector3; b: THREE.Vector3 } | null {
    if (this.measureMode !== "distance" || this.measurePoints.length < 2) return null;
    return { a: this.measurePoints[0].clone(), b: this.measurePoints[1].clone() };
  }

  /** Public: discard the current transient measurement line and markers. */
  clearCurrentMeasurement(): void {
    this.clearMeasurement();
  }

  /**
   * Build a persistent measurement graphic (two markers + connecting line) as a
   * child of the model group, so it follows rolls and orbits with the geometry.
   * Points are in model-local coordinates. Returns the group for later removal.
   */
  addPersistentMeasurement(aLocal: THREE.Vector3, bLocal: THREE.Vector3): THREE.Object3D {
    const group = new THREE.Group();
    for (const p of [aLocal, bLocal]) {
      const geom = new THREE.SphereGeometry(1, 16, 12); // unit; scaled per frame
      const mat = new THREE.MeshBasicMaterial({ color: MEASURE_COLOR });
      const sphere = new THREE.Mesh(geom, mat);
      sphere.position.copy(p);
      group.add(sphere);
      this.registerMarker(sphere);
    }
    const lineGeom = new THREE.BufferGeometry().setFromPoints([aLocal, bLocal]);
    const lineMat = new THREE.LineBasicMaterial({ color: MEASURE_COLOR });
    group.add(new THREE.Line(lineGeom, lineMat));
    group.traverse((o) => (o.raycast = () => {})); // never pickable
    this.model?.add(group);
    return group;
  }

  removePersistentMeasurement(group: THREE.Object3D): void {
    group.traverse((o) => {
      const m = o as THREE.Mesh;
      this.unregisterMarker(m);
      m.geometry?.dispose?.();
      const mat = m.material;
      if (Array.isArray(mat)) mat.forEach((x) => x?.dispose?.());
      else mat?.dispose?.();
    });
    group.parent?.remove(group);
  }

  /** Remove markers/line. `keepReadout` avoids clobbering the pick prompt. */
  private clearMeasurement(keepReadout = false): void {
    this.measurePoints = [];
    this.measureNormals = [];
    this.onMeasureCanKeep?.(false);
    for (const child of [...this.measureGroup.children]) {
      const m = child as THREE.Mesh;
      this.unregisterMarker(m);
      m.geometry?.dispose?.();
      const mat = m.material;
      if (Array.isArray(mat)) mat.forEach((x) => x?.dispose?.());
      else mat?.dispose?.();
      this.measureGroup.remove(child);
    }
    this.onMeasureLabels?.([]);
    if (!keepReadout) {
      this.onMeasureUpdate?.(
        this.measureEnabled ? MEASURE_PROMPTS[this.measureMode] : null,
      );
    }
  }

  private onResize(): void {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    this.perspCamera.aspect = aspect;
    this.perspCamera.updateProjectionMatrix();
    // Keep the ortho camera's vertical extent; adjust horizontal to the aspect.
    const halfV = (this.orthoCamera.top - this.orthoCamera.bottom) / 2 || 1;
    this.orthoCamera.top = halfV;
    this.orthoCamera.bottom = -halfV;
    this.orthoCamera.left = -halfV * aspect;
    this.orthoCamera.right = halfV * aspect;
    this.orthoCamera.updateProjectionMatrix();
  }

  private animate = (): void => {
    this.raf = window.requestAnimationFrame(this.animate);
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
    this.rescaleMarkers();
    this.renderer.render(this.scene, this.camera);
    for (const fn of this.frameCallbacks) fn();
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    window.cancelAnimationFrame(this.raf);
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
    this.scaleMarkers = [];
    this.disposePreview();
    this.sectionCaps?.dispose();
    this.sectionCaps = null;

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
export function formatMm(mm: number): string {
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

/**
 * Approximate solid volume and surface area from a triangle mesh: area is the
 * summed triangle areas; volume is the summed signed tetrahedron volumes (from
 * the origin), whose absolute value is the enclosed volume for a closed shell.
 * Both are approximate — the mesh is a tessellation of the true B-rep.
 */
function volumeAndArea(geom: THREE.BufferGeometry): { volume: number; area: number } {
  const pos = geom.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!pos) return { volume: 0, area: 0 };
  const index = geom.getIndex();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const cross = new THREE.Vector3();
  let vol = 0;
  let area = 0;
  const tri = (i: number, j: number, k: number): void => {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, j);
    c.fromBufferAttribute(pos, k);
    vol += a.dot(cross.copy(b).cross(c)) / 6;
    ab.copy(b).sub(a);
    ac.copy(c).sub(a);
    area += cross.copy(ab).cross(ac).length() / 2;
  };
  const count = index ? index.count : pos.count;
  for (let t = 0; t < count; t += 3) {
    if (index) tri(index.getX(t), index.getX(t + 1), index.getX(t + 2));
    else tri(t, t + 1, t + 2);
  }
  return { volume: Math.abs(vol), area };
}

/** A part's single surface colour as #rrggbb, or undefined for multi-material. */
function meshColor(mesh: THREE.Mesh): string | undefined {
  const mat = mesh.material;
  if (Array.isArray(mat)) return undefined; // per-face colours; no single value
  const c = (mat as THREE.MeshStandardMaterial).color;
  return c ? `#${c.getHexString()}` : undefined;
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/**
 * Circumscribed circle of three points in 3D (centre + radius), or null if the
 * points are (near-)collinear. Used to estimate a hole's radius/diameter from
 * three picks on its edge.
 */
function circleFrom3Points(
  p1: THREE.Vector3,
  p2: THREE.Vector3,
  p3: THREE.Vector3,
): { center: THREE.Vector3; radius: number } | null {
  const v1 = p2.clone().sub(p1);
  const v2 = p3.clone().sub(p1);
  const cross = v1.clone().cross(v2);
  const crossLenSq = cross.lengthSq();
  if (crossLenSq < 1e-12) return null; // collinear

  const v1Sq = v1.lengthSq();
  const v2Sq = v2.lengthSq();
  // Centre = p1 + (‖v1‖²·(v2×n) + ‖v2‖²·(n×v1)) / (2‖n‖²), n = v1×v2.
  const term = v2
    .clone()
    .multiplyScalar(v1Sq)
    .sub(v1.clone().multiplyScalar(v2Sq))
    .cross(cross)
    .divideScalar(2 * crossLenSq);
  const center = p1.clone().add(term);
  const radius = center.distanceTo(p1);
  return { center, radius };
}
