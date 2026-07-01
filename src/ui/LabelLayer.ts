import * as THREE from "three";

export interface LabelHandle {
  el: HTMLElement;
  remove(): void;
}

interface Item {
  el: HTMLElement;
  world: () => THREE.Vector3;
}

/**
 * Renders HTML labels anchored to 3D world positions, projected to screen each
 * frame (a lightweight CSS2D layer). Used for measurement numbers and
 * annotation notes. The container ignores pointer events; individual labels can
 * opt back in via CSS (annotations do, to be editable).
 */
export class LabelLayer {
  private container: HTMLElement;
  private items: Item[] = [];
  private v = new THREE.Vector3();

  constructor(host: HTMLElement) {
    this.container = host.createDiv({ cls: "step-viewer-labels" });
  }

  add(el: HTMLElement, world: () => THREE.Vector3): LabelHandle {
    this.container.appendChild(el);
    const item: Item = { el, world };
    this.items.push(item);
    return {
      el,
      remove: () => {
        const i = this.items.indexOf(item);
        if (i >= 0) this.items.splice(i, 1);
        el.remove();
      },
    };
  }

  update(camera: THREE.Camera, dom: HTMLElement): void {
    const w = dom.clientWidth;
    const h = dom.clientHeight;
    for (const it of this.items) {
      this.v.copy(it.world()).project(camera);
      if (this.v.z > 1 || this.v.z < -1) {
        it.el.toggleClass("step-viewer-label-offscreen", true);
        continue;
      }
      const x = (this.v.x * 0.5 + 0.5) * w;
      const y = (-this.v.y * 0.5 + 0.5) * h;
      it.el.toggleClass("step-viewer-label-offscreen", false);
      it.el.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
    }
  }

  dispose(): void {
    for (const it of this.items) it.el.remove();
    this.items = [];
    this.container.remove();
  }
}
