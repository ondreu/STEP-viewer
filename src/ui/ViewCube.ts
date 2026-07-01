import * as THREE from "three";

const SIZE = 96; // px
const HIGHLIGHT = 0x88aaff;

export interface ViewCubeOptions {
  /** Current main-camera orientation relative to its target. */
  getOrientation: () => { dir: THREE.Vector3; up: THREE.Vector3 };
  /** Called with a unit view direction (from target towards the camera). */
  onSelect: (dir: THREE.Vector3) => void;
}

// BoxGeometry material order is [+X, -X, +Y, -Y, +Z, -Z].
const FACES: { label: string; dir: THREE.Vector3 }[] = [
  { label: "Right", dir: new THREE.Vector3(1, 0, 0) },
  { label: "Left", dir: new THREE.Vector3(-1, 0, 0) },
  { label: "Top", dir: new THREE.Vector3(0, 1, 0) },
  { label: "Bottom", dir: new THREE.Vector3(0, -1, 0) },
  { label: "Front", dir: new THREE.Vector3(0, 0, 1) },
  { label: "Back", dir: new THREE.Vector3(0, 0, -1) },
];

/**
 * A small navigation cube (like a CAD ViewCube). Renders in its own overlay
 * canvas, oriented to match the main camera; clicking a face snaps the main
 * camera to that standard view.
 *
 * It does not run its own render loop — the ViewerController calls `update()`
 * once per frame — and it is disposed with the view (design doc §2.6/§7.2:
 * every WebGL context and material must be released).
 */
export class ViewCube {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private cube: THREE.Mesh;
  private materials: THREE.MeshBasicMaterial[];
  private edges: THREE.LineSegments;
  private raycaster = new THREE.Raycaster();
  private hovered = -1;
  private disposed = false;

  constructor(
    host: HTMLElement,
    private opts: ViewCubeOptions,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(SIZE, SIZE);
    this.renderer.domElement.classList.add("step-viewer-viewcube");
    host.appendChild(this.renderer.domElement);

    const dark = activeDocument.body.classList.contains("theme-dark");
    this.materials = FACES.map((f) => makeFaceMaterial(f.label, dark));
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.materials);
    this.scene.add(this.cube);

    const edgeGeom = new THREE.EdgesGeometry(this.cube.geometry);
    const edgeMat = new THREE.LineBasicMaterial({
      color: dark ? 0x888888 : 0x555555,
    });
    this.edges = new THREE.LineSegments(edgeGeom, edgeMat);
    this.cube.add(this.edges);

    this.camera = new THREE.OrthographicCamera(-0.9, 0.9, 0.9, -0.9, 0.1, 100);

    const el = this.renderer.domElement;
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerleave", this.onPointerLeave);
    el.addEventListener("click", this.onClick);
  }

  /** Called each frame by ViewerController — reorient to the main camera. */
  update(): void {
    if (this.disposed) return;
    const { dir, up } = this.opts.getOrientation();
    this.camera.position.copy(dir).multiplyScalar(5);
    this.camera.up.copy(up);
    this.camera.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.camera);
  }

  private pick(e: PointerEvent | MouseEvent): number {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.cube, false)[0];
    return hit?.face?.materialIndex ?? -1;
  }

  private onPointerMove = (e: PointerEvent): void => {
    const idx = this.pick(e);
    if (idx === this.hovered) return;
    if (this.hovered >= 0) this.materials[this.hovered].color.setHex(0xffffff);
    this.hovered = idx;
    if (idx >= 0) this.materials[idx].color.setHex(HIGHLIGHT);
  };

  private onPointerLeave = (): void => {
    if (this.hovered >= 0) this.materials[this.hovered].color.setHex(0xffffff);
    this.hovered = -1;
  };

  private onClick = (e: MouseEvent): void => {
    const idx = this.pick(e);
    if (idx >= 0) this.opts.onSelect(FACES[idx].dir.clone());
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    const el = this.renderer.domElement;
    el.removeEventListener("pointermove", this.onPointerMove);
    el.removeEventListener("pointerleave", this.onPointerLeave);
    el.removeEventListener("click", this.onClick);

    this.cube.geometry.dispose();
    this.edges.geometry.dispose();
    (this.edges.material as THREE.Material).dispose();
    for (const m of this.materials) {
      m.map?.dispose();
      m.dispose();
    }

    this.renderer.dispose();
    this.renderer.forceContextLoss();
    el.remove();
  }
}

/** Render a face label onto a canvas texture. */
function makeFaceMaterial(label: string, dark: boolean): THREE.MeshBasicMaterial {
  const canvas = activeDocument.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = dark ? "#3a3a3a" : "#e2e2e2";
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = dark ? "#888" : "#999";
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, 124, 124);

  ctx.fillStyle = dark ? "#e0e0e0" : "#303030";
  ctx.font = "bold 22px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, 64, 66);

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  return new THREE.MeshBasicMaterial({ map: texture });
}
