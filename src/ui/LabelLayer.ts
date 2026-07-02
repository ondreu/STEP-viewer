import * as THREE from "three";

export interface LabelHandle {
  el: HTMLElement;
  remove(): void;
}

/**
 * Optional leader: when the getter returns a screen-space offset {x, y}, the
 * label is drawn at anchor+offset with a connector line back to the anchor
 * (a CAD-style leader). Returning null pins the label directly at the anchor.
 */
export type LeaderGetter = () => { x: number; y: number } | null;

interface Item {
  el: HTMLElement;
  world: () => THREE.Vector3;
  leader: LeaderGetter | null;
  line: SVGLineElement | null;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Renders HTML labels anchored to 3D world positions, projected to screen each
 * frame (a lightweight CSS2D layer). Used for measurement numbers and
 * annotation notes. The container ignores pointer events; individual labels can
 * opt back in via CSS (annotations do, to be editable). Leader lines are drawn
 * in a shared SVG overlay behind the labels.
 */
export class LabelLayer {
  private container: HTMLElement;
  private svg: SVGSVGElement;
  private items: Item[] = [];
  private v = new THREE.Vector3();

  constructor(host: HTMLElement) {
    this.container = host.createDiv({ cls: "step-viewer-labels" });
    this.svg = activeDocument.createElementNS(SVG_NS, "svg");
    this.svg.classList.add("step-viewer-leaders");
    this.container.appendChild(this.svg);
  }

  add(el: HTMLElement, world: () => THREE.Vector3, leader: LeaderGetter | null = null): LabelHandle {
    this.container.appendChild(el);
    const line = leader ? this.makeLine() : null;
    const item: Item = { el, world, leader, line };
    this.items.push(item);
    return {
      el,
      remove: () => {
        const i = this.items.indexOf(item);
        if (i >= 0) this.items.splice(i, 1);
        el.remove();
        item.line?.remove();
      },
    };
  }

  private makeLine(): SVGLineElement {
    const line = activeDocument.createElementNS(SVG_NS, "line");
    line.classList.add("step-viewer-leader-line");
    this.svg.appendChild(line);
    return line;
  }

  update(camera: THREE.Camera, dom: HTMLElement): void {
    const w = dom.clientWidth;
    const h = dom.clientHeight;
    for (const it of this.items) {
      this.v.copy(it.world()).project(camera);
      if (this.v.z > 1 || this.v.z < -1) {
        it.el.toggleClass("step-viewer-label-offscreen", true);
        if (it.line) it.line.style.display = "none";
        continue;
      }
      const x = (this.v.x * 0.5 + 0.5) * w;
      const y = (-this.v.y * 0.5 + 0.5) * h;
      it.el.toggleClass("step-viewer-label-offscreen", false);

      const off = it.leader?.() ?? null;
      if (off && it.line) {
        const lx = x + off.x;
        const ly = y + off.y;
        it.el.style.transform = `translate(-50%, -50%) translate(${lx}px, ${ly}px)`;
        it.line.setAttribute("x1", String(x));
        it.line.setAttribute("y1", String(y));
        it.line.setAttribute("x2", String(lx));
        it.line.setAttribute("y2", String(ly));
        it.line.style.display = "";
      } else {
        it.el.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
        if (it.line) it.line.style.display = "none";
      }
    }
  }

  dispose(): void {
    for (const it of this.items) {
      it.el.remove();
      it.line?.remove();
    }
    this.items = [];
    this.svg.remove();
    this.container.remove();
  }
}
