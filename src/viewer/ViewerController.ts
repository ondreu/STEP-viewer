import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { fitCameraToObject } from "./fitCamera";
import { EDGES_TAG, MESH_TAG } from "./StepToThree";
import { SectionCaps } from "./SectionCaps";

const TRANSPARENT_OPACITY = 0.35;
const MEASURE_COLOR = 0xff5500;
const HIGHLIGHT_COLOR = 0xff8a00;
const SELECT_COLOR = 0x3b82f6;
const SNAP_COLOR = 0x22cc66;
const ANNOT_COLOR = 0xffc531;
const SECTION_PLANE_COLOR = 0x3b82f6;
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
// Scratch for the immersive (fly) movement integration.
const _flyDir = new THREE.Vector3();

/** Keys that drive immersive movement — their default (scroll/etc) is suppressed. */
const FLY_KEYS = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "KeyC", "Space",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
]);

/** Details of the part currently under the cursor, for the info panel + tree. */
export interface PartInfo {
  object: THREE.Object3D;
  name: string;
  triangles: number;
  size: { x: number; y: number; z: number };
  /** Part centre in model-local coordinates (mm), stable across view rolls. */
  center: { x: number; y: number; z: number };
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

  // Immersive "walk / fly through the model" mode: pointer-lock mouse-look plus
  // WASD/QE keyboard movement, replacing OrbitControls while active.
  private immersive = false;
  private flyControls: PointerLockControls | null = null;
  private keysDown = new Set<string>();
  private flySpeed = 1; // world units / second, scaled to the model on load
  /** Fired when immersive mode turns on/off (so the toolbar button can sync). */
  onImmersiveChange: ((on: boolean) => void) | null = null;

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
  // Interactive section gizmo: a proxy transform (its local +Z is the cut
  // normal). Its full orientation IS the tilt — the axis buttons seed it flat,
  // then the in-model rotate arcs angle it. Two separate TransformControls share
  // the proxy: an along-normal arrow (translate) that slides the cut, and a
  // pair of in-plane rotation arcs (rotate, local space so they stay bound to
  // the cut, not the camera). They are sized far apart so neither can be grabbed
  // together with the other. A translucent quad on the proxy shows the cut
  // surface itself; the hatch cap (SectionCaps) fills it where it passes through
  // material.
  private sectionProxy: THREE.Object3D | null = null;
  private sectionCaps: SectionCaps | null = null;
  private sectionGizmo: TransformControls | null = null;
  private sectionRotateGizmo: TransformControls | null = null;
  private sectionPlaneVis: THREE.Object3D | null = null;

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
  /** Called when a part is double-clicked (after it's framed + selected), so the
   *  UI can open the structure tree and reveal the part there. */
  onDoubleClickPart: ((info: PartInfo | null) => void) | null = null;
  /** Called on right-click with the part under the cursor (or null) and the
   *  screen coordinates, so the UI can open a context menu there. */
  onContextMenu: ((info: PartInfo | null, clientX: number, clientY: number) => void) | null = null;

  /** Called each frame after rendering (drives the view cube + label overlays). */
  private frameCallbacks: Array<() => void> = [];
  /** Extra resources (e.g. the view cube) torn down with this controller. */
  private disposables: Array<{ dispose(): void }> = [];
  private clock = new THREE.Clock();

  // Measurement state (design doc §1: results are approximate — mesh, not B-rep).
  private measureEnabled = false;
  private snapEnabled = true; // snap to corners/edges/hole-centres on by default
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
    this.renderer = createRenderer();
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
    el.addEventListener("dblclick", this.onDoubleClick);
    el.addEventListener("contextmenu", this.onContextMenuEvent);

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

    const box = new THREE.Box3().setFromObject(group);
    const diag = box.isEmpty() ? 1 : box.getSize(new THREE.Vector3()).length();
    this.modelDiag = diag;
    this.markerRadius = Math.max(diag * 0.006, 1e-4);
    this.snapThreshold = this.markerRadius * 4;
    // Base fly speed crosses the model in a few seconds; Shift boosts it.
    this.flySpeed = Math.max(diag * 0.5, 1e-3);

    // Record top-level parts for explode (outward direction from assembly centre).
    // Many STEP files wrap the whole model in a single root assembly node (and
    // sometimes several nested single-child wrappers). Exploding those direct
    // children would just translate the whole model as one block, so descend
    // through single-child wrapper groups to the first level with real siblings.
    this.explodeParts = [];
    this.exploded = 0;
    let explodeRoot: THREE.Object3D = group;
    while (
      explodeRoot.children.length === 1 &&
      !(explodeRoot.children[0] as THREE.Mesh).userData?.[MESH_TAG]
    ) {
      explodeRoot = explodeRoot.children[0];
    }
    const center = box.getCenter(new THREE.Vector3());
    for (const child of explodeRoot.children) {
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
    this.resizeSectionVis();
    this.scene.add(group);
    fitCameraToObject(this.camera, this.controls, group);
  }

  resetCamera(): void {
    if (this.model) fitCameraToObject(this.camera, this.controls, this.model);
  }

  /** Frame a specific object (used when a structure-tree node is clicked). */
  focusObject(object: THREE.Object3D): void {
    fitCameraToObject(this.camera, this.controls, object);
    // In orthographic, fitCameraToObject sizes the frustum *and* the near/far to
    // the framed object. For a small internal part that leaves the camera inside
    // the model with near/far spanning only the part, so the rest of the model is
    // clipped away — it looks like a stray section cut. Parallel projection means
    // the camera distance doesn't affect framing, so we can safely pull it back
    // outside the whole model and widen near/far to span it. (Perspective is
    // unaffected: its tiny near / huge far already avoid this.)
    if (this.orthographic && this.model) {
      const box = new THREE.Box3().setFromObject(this.model);
      if (box.isEmpty()) return;
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const dir = this.camera.position.clone().sub(this.controls.target);
      if (dir.lengthSq() < 1e-9) dir.set(1, 0.8, 1);
      dir.normalize();
      const dist = sphere.radius * 3 + 1;
      this.orthoCamera.position.copy(this.controls.target).addScaledVector(dir, dist);
      this.orthoCamera.near = 0.001;
      this.orthoCamera.far = (dist + sphere.radius * 2) * 2;
      this.orthoCamera.updateProjectionMatrix();
      this.controls.update();
    }
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
    if (this.sectionGizmo) this.sectionGizmo.camera = this.camera;
    if (this.sectionRotateGizmo) this.sectionRotateGizmo.camera = this.camera;
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
    if (on) {
      this.ensureSectionGizmo();
      this.updateSectionPlane();
    }
    this.applySection();
    this.sectionCaps?.setEnabled(on);
    this.showSectionGizmo(on);
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
    // Flipping only swaps the kept side — the plane (and its tilt/position) is
    // unchanged, so just re-derive the clip normal with the new sign.
    this.deriveSectionPlaneFromProxy();
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

  /**
   * Seat the section proxy flat on the chosen axis at the current position, then
   * derive the clip plane from it. Choosing an axis resets any tilt (a fresh,
   * axis-aligned cut); the in-model arrow (move) and arcs (tilt) take it from
   * there. The gizmos share this proxy, so they and the panel drive one cut.
   */
  private updateSectionPlane(): void {
    if (!this.model) return;
    const box = new THREE.Box3().setFromObject(this.model);
    if (box.isEmpty()) return;
    this.ensureSectionGizmo();
    const proxy = this.sectionProxy!;
    const axis = this.sectionAxis;
    const lo = box.min[axis];
    const hi = box.max[axis];
    const pos = lo + (hi - lo) * this.sectionT;
    const point = box.getCenter(new THREE.Vector3());
    point[axis] = pos;
    proxy.position.copy(point);
    proxy.quaternion.copy(this.baseSectionOrientation());
    proxy.updateMatrixWorld(true);
    this.deriveSectionPlaneFromProxy();
  }

  /** The axis-aligned base orientation (no tilt, no flip): local +Z along the
   *  chosen axis. The rotate arcs then tilt the proxy off this. */
  private baseSectionOrientation(): THREE.Quaternion {
    const axis = this.sectionAxis;
    const n = new THREE.Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0);
    return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  }

  /** Read the clip plane off the proxy's transform (its local +Z is the normal),
   *  so the panel, the move arrow and the tilt arcs all update the same cut.
   *  `flip` negates the kept side without moving the plane. */
  private deriveSectionPlaneFromProxy(): void {
    if (!this.model || !this.sectionProxy) return;
    const n = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(this.sectionProxy.quaternion)
      .normalize();
    if (this.sectionFlip) n.negate();
    this.sectionPlane.normal.copy(n);
    // distance(p) = n·p + constant, keeps p where distance ≥ 0.
    this.sectionPlane.constant = -n.dot(this.sectionProxy.position);
    const box = new THREE.Box3().setFromObject(this.model);
    this.sectionCaps?.update(box.getCenter(new THREE.Vector3()));
  }

  /**
   * Create the section proxy, the two in-model handles (an along-normal move
   * arrow and a pair of in-plane tilt arcs) and the translucent plane that
   * shows the cut surface. The arcs use local space so they stay bound to the
   * cut (not the camera), and are sized well outside the arrow so the two can't
   * be grabbed together.
   */
  private ensureSectionGizmo(): void {
    if (this.sectionGizmo) return;
    const proxy = new THREE.Object3D();
    this.scene.add(proxy);
    this.sectionProxy = proxy;

    // A translucent quad + outline on the proxy's local XY plane, showing the
    // cut surface itself so the user can see where (and how tilted) it is.
    proxy.add(this.buildSectionPlaneVis());

    // Move-along-normal arrow (translate). Kept compact so it sits near the
    // centre, well inside the tilt arcs.
    const move = new TransformControls(this.camera, this.renderer.domElement);
    move.setSpace("local"); // arrow points along the (tilted) cut normal
    move.setMode("translate");
    move.setSize(0.7);
    move.attach(proxy);
    move.showX = false;
    move.showY = false;
    move.showZ = true; // only the along-normal arrow
    this.scene.add(move);
    this.sectionGizmo = move;

    // Tilt arcs (rotate). Local space so they follow the cut; only the two
    // in-plane axes (X/Y) — hiding Z also hides the camera-aligned E/XYZE rings
    // (TransformControls only shows those when all three axes are on). Larger
    // than the arrow so its rings sit far outside the arrow's grab zone.
    const rotate = new TransformControls(this.camera, this.renderer.domElement);
    rotate.setSpace("local");
    rotate.setMode("rotate");
    rotate.setSize(1.5);
    rotate.attach(proxy);
    rotate.showX = true;
    rotate.showY = true;
    rotate.showZ = false; // spinning about the normal doesn't change the cut
    this.scene.add(rotate);
    this.sectionRotateGizmo = rotate;

    // Suspend orbiting while either handle is dragged, and disable the other so
    // a drag started on one can never also grab the other. Re-derive live.
    const onDrag = (other: TransformControls) => (event: unknown): void => {
      const active = (event as { value: boolean }).value;
      this.controls.enabled = !active;
      other.enabled = !active;
    };
    move.addEventListener("dragging-changed", onDrag(rotate));
    rotate.addEventListener("dragging-changed", onDrag(move));
    move.addEventListener("objectChange", () => this.deriveSectionPlaneFromProxy());
    rotate.addEventListener("objectChange", () => this.deriveSectionPlaneFromProxy());

    this.showSectionGizmo(this.sectionEnabled);
  }

  /** The cut-plane marker parented to the proxy: just an outline (no fill), so
   *  it shows where the cut is without veiling the view into the model. Built
   *  from a unit plane; the group is scaled to the model in `resizeSectionVis`. */
  private buildSectionPlaneVis(): THREE.Object3D {
    const group = new THREE.Group();
    group.raycast = () => {};

    const border = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)),
      new THREE.LineBasicMaterial({ color: SECTION_PLANE_COLOR, transparent: true, opacity: 0.8 }),
    );
    border.renderOrder = 4;
    border.raycast = () => {};
    group.add(border);

    this.sectionPlaneVis = group;
    group.scale.setScalar(Math.max(this.modelDiag, 1));
    group.visible = this.sectionEnabled;
    return group;
  }

  /** Scale the cut-surface quad to the current model (called on model load). */
  private resizeSectionVis(): void {
    this.sectionPlaneVis?.scale.setScalar(Math.max(this.modelDiag, 1));
  }

  private showSectionGizmo(on: boolean): void {
    if (this.sectionPlaneVis) this.sectionPlaneVis.visible = on;
    for (const g of [this.sectionGizmo, this.sectionRotateGizmo]) {
      if (!this.sectionProxy || !g) continue;
      g.enabled = on;
      g.visible = on;
      if (on) g.attach(this.sectionProxy);
      else g.detach();
    }
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
    // Parts spread relative to the world-space clip plane; re-gate which meshes
    // it still intersects so the cap doesn't shadow non-cut parts.
    this.sectionCaps?.refresh();
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
        // depthTest:false lets the selection highlight glow *through* any parts
        // in front of it, so a selected part stays visible even when occluded.
        const mat = new THREE.MeshBasicMaterial({
          color: SELECT_COLOR,
          transparent: true,
          opacity: 0.45,
          depthWrite: false,
          depthTest: false,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
        });
        const overlay = new THREE.Mesh(mesh.geometry, mat);
        overlay.renderOrder = 4; // draw last, over both geometry and hover
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
    // While a part is isolated its (blue) selection highlight is redundant —
    // nothing else is shown to distinguish it from — so hide the overlays and
    // restore them when isolate turns off.
    for (const overlay of this.selectOverlays) overlay.visible = !active;
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

  // --- Mesh export ---------------------------------------------------------

  /**
   * Serialize the meshes under `root` (or the selected part, or the whole model)
   * to Wavefront OBJ in world coordinates. This exports the exact tessellated
   * geometry the viewer holds — useful for isolating a single part and for
   * diagnostics. It is a mesh export, not STEP/BREP (the parser is read-only).
   * Returns null if there is nothing to export.
   */
  exportObj(root?: THREE.Object3D | null): string | null {
    const target = root ?? this.selected ?? this.model;
    if (!target) return null;

    const lines: string[] = ["# STEP Viewer OBJ export"];
    let vOffset = 0;
    let exported = 0;
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    const normalMat = new THREE.Matrix3();

    target.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.userData?.[MESH_TAG] || !mesh.geometry) return;
      const geom = mesh.geometry;
      const position = geom.getAttribute("position");
      const normal = geom.getAttribute("normal");
      const index = geom.getIndex();
      if (!position) return;

      mesh.updateWorldMatrix(true, false);
      normalMat.getNormalMatrix(mesh.matrixWorld);

      lines.push(`o ${(mesh.name || "part").replace(/\s+/g, "_")}_${exported}`);
      for (let i = 0; i < position.count; i++) {
        p.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
        lines.push(`v ${p.x} ${p.y} ${p.z}`);
      }
      if (normal) {
        for (let i = 0; i < normal.count; i++) {
          n.fromBufferAttribute(normal, i).applyMatrix3(normalMat).normalize();
          lines.push(`vn ${n.x} ${n.y} ${n.z}`);
        }
      }
      const emitFace = (a: number, b: number, c: number): void => {
        const A = vOffset + a + 1, B = vOffset + b + 1, C = vOffset + c + 1;
        lines.push(
          normal ? `f ${A}//${A} ${B}//${B} ${C}//${C}` : `f ${A} ${B} ${C}`,
        );
      };
      if (index) {
        for (let t = 0; t < index.count; t += 3) {
          emitFace(index.getX(t), index.getX(t + 1), index.getX(t + 2));
        }
      } else {
        for (let i = 0; i < position.count; i += 3) emitFace(i, i + 1, i + 2);
      }
      vOffset += position.count;
      exported++;
    });

    return exported > 0 ? lines.join("\n") : null;
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
    // Parts move relative to the world-space clip plane mid-roll, so re-gate
    // which meshes the plane still intersects (else the cap shadow flickers).
    this.sectionCaps?.refresh();
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

  // --- Immersive (walk / fly) mode ----------------------------------------

  isImmersive(): boolean {
    return this.immersive;
  }

  /**
   * Toggle first-person immersion: pointer-lock mouse-look with WASD movement,
   * Q/E (or C/Space) for down/up, and Shift to move faster — you fly through
   * the model like a fly. Returns the new state.
   */
  toggleImmersive(): boolean {
    this.setImmersive(!this.immersive);
    return this.immersive;
  }

  private setImmersive(on: boolean): void {
    if (on === this.immersive) return;
    if (on) {
      // Immersion is a perspective, orbit-free mode; drop conflicting modes.
      if (this.orthographic) this.setProjection(false);
      if (this.measureEnabled) this.toggleMeasure();
      if (this.annotateEnabled) this.setAnnotate(false);
      this.setHover(null);
      this.controls.enabled = false;
      if (!this.flyControls) {
        this.flyControls = new PointerLockControls(this.perspCamera, this.renderer.domElement);
        this.flyControls.addEventListener("unlock", this.onFlyUnlock);
      }
      this.immersive = true;
      this.host.toggleClass("is-immersive", true);
      activeWindow.addEventListener("keydown", this.onFlyKeyDown);
      activeWindow.addEventListener("keyup", this.onFlyKeyUp);
      this.flyControls.lock(); // requested from the toolbar click (a user gesture)
    } else {
      this.immersive = false;
      this.host.toggleClass("is-immersive", false);
      this.keysDown.clear();
      activeWindow.removeEventListener("keydown", this.onFlyKeyDown);
      activeWindow.removeEventListener("keyup", this.onFlyKeyUp);
      if (this.flyControls?.isLocked) this.flyControls.unlock();
      // Re-anchor the orbit target ahead of where we ended up so it doesn't jump.
      this.perspCamera.getWorldDirection(_flyDir);
      this.controls.target
        .copy(this.perspCamera.position)
        .addScaledVector(_flyDir, this.modelDiag * 0.5);
      this.controls.enabled = true;
      this.controls.update();
    }
    this.onImmersiveChange?.(this.immersive);
  }

  /** Escape releases pointer lock (browser default) — leave immersive mode too. */
  private onFlyUnlock = (): void => {
    if (this.immersive) this.setImmersive(false);
  };

  private onFlyKeyDown = (e: KeyboardEvent): void => {
    if (!this.immersive) return;
    if (FLY_KEYS.has(e.code)) e.preventDefault(); // don't scroll the note
    this.keysDown.add(e.code);
  };

  private onFlyKeyUp = (e: KeyboardEvent): void => {
    this.keysDown.delete(e.code);
  };

  /** Integrate one frame of immersive movement from the held keys. */
  private updateFly(dt: number): void {
    if (!this.immersive || !this.flyControls?.isLocked) return;
    const k = this.keysDown;
    const boost = k.has("ShiftLeft") || k.has("ShiftRight") ? 3.5 : 1;
    const step = this.flySpeed * boost * dt;
    const fwd =
      (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) -
      (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
    const strafe =
      (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) -
      (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0);
    const rise =
      (k.has("Space") || k.has("KeyE") ? 1 : 0) - (k.has("KeyC") || k.has("KeyQ") ? 1 : 0);
    if (fwd) {
      this.flyControls.getDirection(_flyDir); // full look direction (true fly)
      this.perspCamera.position.addScaledVector(_flyDir, fwd * step);
    }
    if (strafe) this.flyControls.moveRight(strafe * step);
    if (rise) this.perspCamera.position.y += rise * step;
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
    // Report the centre in model-local space so it doesn't change when the view
    // is rolled (the model group is what rotates, not the geometry).
    const center = this.worldToLocal(box.getCenter(new THREE.Vector3()));
    const index = mesh.geometry.getIndex();
    const posCount = mesh.geometry.getAttribute("position")?.count ?? 0;
    const triangles = index ? index.count / 3 : posCount / 3;
    const { volume, area } = volumeAndArea(mesh.geometry);
    return {
      object: mesh,
      name: mesh.name,
      triangles: Math.round(triangles),
      size: { x: size.x, y: size.y, z: size.z },
      center: { x: center.x, y: center.y, z: center.z },
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
    const threshold =
      e.pointerType === "touch" ? TOUCH_MOVE_THRESHOLD : CLICK_MOVE_THRESHOLD;
    const moved = Math.hypot(e.clientX - this.pointerDownX, e.clientY - this.pointerDownY);
    // Right button: open the context menu here (on release) rather than on the
    // browser `contextmenu` event, which on some platforms (Linux) fires on
    // press — so a right-drag pan would pop the menu mid-pan. Only a stationary
    // release opens it; a drag is treated as an orbit/pan.
    if (e.button === 2) {
      if (moved <= threshold) this.openContextMenu(e.clientX, e.clientY);
      return;
    }
    if (e.button !== 0) return;
    if (moved > threshold) return; // it was an orbit drag, not a tap
    if (this.measureEnabled) this.pickMeasurePoint(e);
    else if (this.annotateEnabled) this.pickAnnotate(e);
    // Otherwise a plain click selects the part under the cursor: the highlight
    // sticks (persistent selection) and the structure tree reveals it. Hover
    // (mouse-over) only shows the transient highlight — it never selects.
    else this.pickSelect(e);
  };

  /**
   * Double-clicking a part frames it in the view (focus) and selects it, then
   * lets the UI reveal it in the structure tree (opening the tree if needed).
   * Ignored while measuring/annotating so it doesn't fight those modes.
   */
  private onDoubleClick = (e: MouseEvent): void => {
    if (this.measureEnabled || this.annotateEnabled) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const mesh =
      (this.raycaster.intersectObjects(this.visiblePickables(), false)[0]
        ?.object as THREE.Mesh) ?? null;
    if (!mesh) return;
    this.setSelected(mesh);
    this.focusObject(mesh);
    this.onDoubleClickPart?.(this.describePart(mesh));
  };

  /**
   * Swallow the browser's native right-click menu over the canvas. The viewer's
   * own menu is opened from `onPointerUp` (on release, after we know whether the
   * right button was dragged to pan) — not here, because the `contextmenu` event
   * fires on press on some platforms and would pop the menu mid-pan.
   */
  private onContextMenuEvent = (e: MouseEvent): void => {
    e.preventDefault();
  };

  /** Raycast under the cursor and ask the UI to pop the context menu there. */
  private openContextMenu(clientX: number, clientY: number): void {
    if (!this.onContextMenu) return;
    if (this.measureEnabled || this.annotateEnabled || this.immersive) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const mesh =
      (this.raycaster.intersectObjects(this.visiblePickables(), false)[0]
        ?.object as THREE.Mesh) ?? null;
    this.onContextMenu(mesh ? this.describePart(mesh) : null, clientX, clientY);
  }

  /** Hide a single object (used by the right-click menu). */
  hideObject(object: THREE.Object3D): void {
    object.visible = false;
  }

  /**
   * Make every mesh under `object` see-through (so parts in front of it stop
   * blocking what's behind), used by the RMB "Make this object transparent".
   * Independent of the global transparency toggle: it sets material state on
   * the object's meshes only. `makeAllSolid` reverts it.
   */
  makeObjectTransparent(object: THREE.Object3D): void {
    object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.userData?.[MESH_TAG]) return;
      const material = mesh.material;
      for (const m of Array.isArray(material) ? material : [material]) {
        if (!m) continue;
        m.transparent = true;
        m.opacity = TRANSPARENT_OPACITY;
        m.depthWrite = false;
        m.needsUpdate = true;
      }
    });
  }

  /**
   * Restore every mesh to fully opaque — reverts both `makeObjectTransparent`
   * and the global transparency toggle. Used by the RMB "Make all objects
   * solid".
   */
  makeAllSolid(): void {
    this.transparent = false;
    this.applyTransparency();
  }

  /** Isolate `object`: select it and turn isolate on (hides everything else). */
  isolateObject(object: THREE.Object3D): void {
    this.setSelected(object);
    if (!this.isolated) this.toggleIsolate();
  }

  /** Reveal every part: clear isolate and unhide all meshes + assembly groups. */
  showAll(): void {
    if (this.isolated) this.toggleIsolate(); // restores isolate-hidden parts
    this.model?.traverse((o) => {
      if ((o as THREE.Mesh).userData?.[MESH_TAG] || (o as THREE.Group).isGroup) {
        o.visible = true;
      }
    });
  }

  private pickSelect(e: PointerEvent): void {
    // In immersive mode the pointer is locked, so screen coordinates are frozen:
    // pick from the centre of the view (where the crosshair sits) instead.
    const ndc = this.eventNdc(e);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.visiblePickables(), false)[0];
    const mesh = (hit?.object as THREE.Mesh) ?? null;
    // Isolate is not sticky: a click in the scene exits isolate rather than
    // re-isolating onto whatever was clicked (you enable it via the RMB menu).
    if (this.isolated) this.toggleIsolate();
    this.setSelected(mesh);
    this.onSelectPart?.(mesh ? this.describePart(mesh) : null);
  }

  /** Pointer position in NDC, or screen-centre while the pointer is locked. */
  private eventNdc(e: PointerEvent): THREE.Vector2 {
    if (this.immersive) return new THREE.Vector2(0, 0);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
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
   * Circular edge loops (hole rims / round bosses) of `mesh`, in mesh-local
   * space, detected once from the feature-edge geometry and cached. Local space
   * so the cache survives model rolls (we transform to world at snap time).
   */
  private meshCircles(mesh: THREE.Mesh): CircleFeature[] {
    const cached = mesh.userData.__stepCircles as CircleFeature[] | undefined;
    if (cached) return cached;
    const edges = mesh.children.find((c) => c.userData?.[EDGES_TAG]) as
      | THREE.LineSegments
      | undefined;
    const pos = edges?.geometry.getAttribute("position") as
      | THREE.BufferAttribute
      | undefined;
    const circles = pos ? detectCircles(pos) : [];
    mesh.userData.__stepCircles = circles;
    return circles;
  }

  /**
   * If `p` (world) lies on or near a circular edge of `mesh`, return that
   * circle's centre in world space. Used so measurement/annotation snap can grab
   * a hole's centre — you click the round edge and it jumps to the middle.
   */
  private snapHoleCenter(mesh: THREE.Mesh, p: THREE.Vector3): THREE.Vector3 | null {
    const circles = this.meshCircles(mesh);
    if (circles.length === 0) return null;

    mesh.updateWorldMatrix(true, false);
    const mw = mesh.matrixWorld;
    const scale = mesh.getWorldScale(_tmpS).x || 1;

    const cw = new THREE.Vector3();
    const nw = new THREE.Vector3();
    const proj = new THREE.Vector3();
    const plane = new THREE.Plane();
    let best: THREE.Vector3 | null = null;
    let bestScore = Infinity;

    for (const c of circles) {
      cw.copy(c.center).applyMatrix4(mw);
      nw.copy(c.normal).transformDirection(mw).normalize();
      const r = c.radius * scale;
      plane.setFromNormalAndCoplanarPoint(nw, cw);
      const planeDist = Math.abs(plane.distanceToPoint(p));
      if (planeDist > this.snapThreshold) continue;
      plane.projectPoint(p, proj);
      const ring = Math.abs(proj.distanceTo(cw) - r); // distance to the rim
      if (ring > this.snapThreshold) continue;
      const score = planeDist + ring;
      if (score < bestScore) {
        bestScore = score;
        best = cw.clone();
      }
    }
    return best;
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

    // A hole's centre wins over its rim corners/edges: clicking a circular edge
    // snaps to the circle's centre (design ask: snap to hole centres too).
    const holeCenter = this.snapHoleCenter(mesh, p);
    if (holeCenter) return holeCenter;

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
    let parentScale = 1;
    if (m.parent) parentScale = m.parent.getWorldScale(_tmpS).x || 1;
    m.scale.setScalar(this.markerWorldRadius(_tmpV) / parentScale);
  }

  /**
   * World-space radius a marker needs at `point` to read as a constant on-screen
   * size. Perspective uses camera distance (zoom changes position via dolly, so
   * distance already reflects it). Orthographic zoom, however, changes the
   * frustum — not the camera position — so distance is constant and markers
   * wouldn't scale with zoom; we use the visible world height / zoom instead.
   */
  private markerWorldRadius(point: THREE.Vector3): number {
    if (this.orthographic) {
      const o = this.orthoCamera;
      const visibleH = (o.top - o.bottom) / (o.zoom || 1);
      return visibleH * MARKER_SCREEN;
    }
    const dist = this.camera.position.distanceTo(point) || 1;
    return dist * MARKER_SCREEN;
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
    // Same orthographic caveat as markerWorldRadius: ortho zoom changes the
    // frustum, not the camera distance, so scale by visible height / zoom.
    const r = this.orthographic
      ? ((this.orthoCamera.top - this.orthoCamera.bottom) / (this.orthoCamera.zoom || 1)) * 0.012
      : Math.max((this.camera.position.distanceTo(this.previewMesh.position) || 1) * 0.012, 1e-4);
    this.previewMesh.scale.setScalar(Math.max(r, 1e-4));
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
    if (this.immersive) this.updateFly(dt);
    else this.controls.update();
    // Frame-throttled pointer raycasting; suppressed while dragging (orbit) or
    // in immersive mode (the pointer is locked, so screen NDC is meaningless).
    // In measure mode it drives the snap preview; otherwise the hover highlight.
    if (this.hoverPending && !this.dragging && !this.immersive) {
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

    if (this.immersive) this.host.toggleClass("is-immersive", false);
    activeWindow.removeEventListener("keydown", this.onFlyKeyDown);
    activeWindow.removeEventListener("keyup", this.onFlyKeyUp);
    if (this.flyControls) {
      this.flyControls.removeEventListener("unlock", this.onFlyUnlock);
      if (this.flyControls.isLocked) this.flyControls.unlock();
      this.flyControls.dispose();
      this.flyControls = null;
    }

    const el = this.renderer.domElement;
    el.removeEventListener("pointerdown", this.onPointerDown);
    el.removeEventListener("pointermove", this.onPointerMove);
    el.removeEventListener("pointerup", this.onPointerUp);
    el.removeEventListener("pointerleave", this.onPointerLeave);
    el.removeEventListener("dblclick", this.onDoubleClick);
    el.removeEventListener("contextmenu", this.onContextMenuEvent);

    for (const d of this.disposables) d.dispose();
    this.disposables = [];

    this.clearHighlight();
    this.hovered = null;
    this.clearMeasurement(true);
    this.scaleMarkers = [];
    this.disposePreview();
    this.sectionCaps?.dispose();
    this.sectionCaps = null;

    for (const g of [this.sectionGizmo, this.sectionRotateGizmo]) {
      if (!g) continue;
      g.detach();
      g.dispose();
      this.scene.remove(g);
    }
    this.sectionGizmo = null;
    this.sectionRotateGizmo = null;
    if (this.sectionPlaneVis) {
      this.sectionPlaneVis.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material;
        if (Array.isArray(mat)) mat.forEach((x) => x?.dispose?.());
        else mat?.dispose?.();
      });
      this.sectionPlaneVis = null;
    }
    if (this.sectionProxy) {
      this.scene.remove(this.sectionProxy);
      this.sectionProxy = null;
    }

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

/** A circular edge loop (hole rim / round boss), in the mesh's local space. */
interface CircleFeature {
  center: THREE.Vector3;
  radius: number;
  normal: THREE.Vector3;
}

/**
 * Detect circular edge loops in a LineSegments position buffer (the feature
 * edges we already build for display). A hole's rim comes back as a closed
 * chain of short segments whose vertices are co-planar and equidistant from a
 * centre — we weld endpoints, split into connected components where every
 * vertex has degree 2 (simple cycles), then keep the ones that fit a circle.
 */
function detectCircles(pos: THREE.BufferAttribute): CircleFeature[] {
  // Weld coincident endpoints so the rim reads as one connected loop.
  const map = new Map<string, number>();
  const verts: THREE.Vector3[] = [];
  const v = new THREE.Vector3();
  const idxOf = (i: number): number => {
    v.fromBufferAttribute(pos, i);
    const k = `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
    let j = map.get(k);
    if (j === undefined) {
      j = verts.length;
      verts.push(v.clone());
      map.set(k, j);
    }
    return j;
  };
  const adj = new Map<number, number[]>();
  const link = (a: number, b: number): void => {
    if (a === b) return;
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  };
  for (let i = 0; i + 1 < pos.count; i += 2) link(idxOf(i), idxOf(i + 1));

  const circles: CircleFeature[] = [];
  const seen = new Set<number>();
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    // Gather the connected component; a clean loop has every vertex degree 2.
    const comp: number[] = [];
    const stack = [start];
    seen.add(start);
    let simpleCycle = true;
    while (stack.length) {
      const u = stack.pop()!;
      comp.push(u);
      const ns = adj.get(u)!;
      if (ns.length !== 2) simpleCycle = false;
      for (const w of ns) if (!seen.has(w)) { seen.add(w); stack.push(w); }
    }
    if (!simpleCycle || comp.length < 8) continue; // need a real ring

    const circle = fitCircle(verts, adj, start, comp.length);
    if (circle) circles.push(circle);
  }
  return circles;
}

/**
 * Walk the degree-2 loop starting at `start` and, if it closes cleanly, fit a
 * circle to it: near-constant radius from the centroid and near-planar. Returns
 * null when the loop isn't circular (a rectangle, an irregular contour, …).
 */
function fitCircle(
  verts: THREE.Vector3[],
  adj: Map<number, number[]>,
  start: number,
  size: number,
): CircleFeature | null {
  // Order the loop by walking the adjacency (each vertex has exactly 2 links).
  const order: number[] = [];
  let prev = -1;
  let cur = start;
  for (let i = 0; i < size; i++) {
    order.push(cur);
    const ns = adj.get(cur)!;
    const nxt = ns[0] === prev ? ns[1] : ns[0];
    prev = cur;
    cur = nxt;
  }
  if (cur !== start) return null; // didn't return to the start → not one cycle

  const center = new THREE.Vector3();
  for (const i of order) center.add(verts[i]);
  center.divideScalar(order.length);

  // Newell's method for the loop's plane normal.
  const normal = new THREE.Vector3();
  for (let i = 0; i < order.length; i++) {
    const a = verts[order[i]];
    const b = verts[order[(i + 1) % order.length]];
    normal.x += (a.y - b.y) * (a.z + b.z);
    normal.y += (a.z - b.z) * (a.x + b.x);
    normal.z += (a.x - b.x) * (a.y + b.y);
  }
  if (normal.lengthSq() < 1e-12) return null;
  normal.normalize();

  // Mean radius, then reject if the radius varies too much (not round) or if
  // any vertex sits well off the plane (not planar).
  let rSum = 0;
  for (const i of order) rSum += verts[i].distanceTo(center);
  const r = rSum / order.length;
  if (r < 1e-4) return null;
  for (const i of order) {
    const d = verts[i].distanceTo(center);
    if (Math.abs(d - r) > 0.15 * r) return null; // radius spread > 15%
    if (Math.abs(verts[i].clone().sub(center).dot(normal)) > 0.05 * r) return null;
  }
  return { center, radius: r, normal };
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
 * Create the WebGL renderer, guaranteeing a working stencil buffer. The section
 * hatch cap masks the cut cross-section with the stencil buffer (SectionCaps);
 * without one the mask always passes and the hatch floods the whole cut plane
 * instead of just the cut solids. Some GPUs/drivers don't provide stencil
 * alongside MSAA on the default framebuffer, so if antialiasing left us without
 * stencil bits we drop antialiasing (kept sharp by the device pixel ratio) to
 * get stencil back — correct sectioning matters more than edge smoothing.
 */
function createRenderer(): THREE.WebGLRenderer {
  const make = (antialias: boolean): THREE.WebGLRenderer =>
    new THREE.WebGLRenderer({ antialias, alpha: true, stencil: true });
  let renderer = make(true);
  let bits = 0;
  try {
    const gl = renderer.getContext();
    bits = gl.getParameter(gl.STENCIL_BITS) as number;
  } catch {
    bits = 0;
  }
  if (!bits) {
    renderer.dispose();
    renderer.forceContextLoss();
    renderer = make(false);
  }
  return renderer;
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
