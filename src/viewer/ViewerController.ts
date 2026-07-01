import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { fitCameraToObject } from "./fitCamera";
import { EDGES_TAG, MESH_TAG } from "./StepToThree";

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

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.domElement.classList.add("step-viewer-canvas");
    host.appendChild(this.renderer.domElement);

    this.scene.background = null; // let CSS theme background show through

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
    this.model = group;
    this.applyWireframe();
    this.applyEdgesVisibility();
    this.scene.add(group);
    fitCameraToObject(this.camera, this.controls, group);
  }

  resetCamera(): void {
    if (this.model) fitCameraToObject(this.camera, this.controls, this.model);
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

  isWireframe(): boolean {
    return this.wireframe;
  }

  isEdgesVisible(): boolean {
    return this.edgesVisible;
  }

  private applyWireframe(): void {
    if (!this.model) return;
    this.model.traverse((o) => {
      if (!(o as THREE.Mesh).userData?.[MESH_TAG]) return;
      const material = (o as THREE.Mesh).material;
      for (const m of Array.isArray(material) ? material : [material]) {
        if (m && "wireframe" in m) {
          (m as THREE.MeshStandardMaterial).wireframe = this.wireframe;
        }
      }
    });
  }

  private applyEdgesVisibility(): void {
    if (!this.model) return;
    this.model.traverse((o) => {
      if (o.userData?.[EDGES_TAG]) o.visible = this.edgesVisible;
    });
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

    if (this.model) {
      this.scene.remove(this.model);
      this.disposeGroup(this.model);
      this.model = null;
    }

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
