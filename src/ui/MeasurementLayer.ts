import * as THREE from "three";
import { ViewerController, formatMm } from "../viewer/ViewerController";
import { LabelLayer, LabelHandle } from "./LabelLayer";
import { MeasurementStore, StoredMeasurement } from "../annotations/MeasurementStore";

interface Live {
  data: StoredMeasurement;
  graphic: THREE.Object3D;
  label: LabelHandle;
  /** Endpoints (model-local) + cached readout, for the list panel & isolate. */
  a: THREE.Vector3;
  b: THREE.Vector3;
  text: string;
}

/** Row data for the measurements section of the annotations list panel. */
export interface MeasurementItem {
  id: string;
  text: string;
}

/**
 * Pinned (persistent) measurements. Each one is a marker/line graphic parented
 * to the model group (so it follows rolls) plus a distance label projected by
 * the LabelLayer. Endpoints are stored in model-local coordinates and persisted
 * per file path via MeasurementStore — the same architecture as AnnotationLayer.
 */
export class MeasurementLayer {
  private items: Live[] = [];
  private saveTimer: number | null = null;
  private visible = true;
  // When isolate is active, only measurements with an endpoint inside this world
  // box (the isolated part's bounds) are shown; null = no isolate restriction.
  private isolateBox: THREE.Box3 | null = null;
  /** Fired when measurements are added/removed (drives the list panel). */
  onChange: (() => void) | null = null;

  constructor(
    private controller: ViewerController,
    private labelLayer: LabelLayer,
    private store: MeasurementStore,
    private path: string,
  ) {}

  async load(): Promise<void> {
    const list = await this.store.get(this.path);
    for (const d of list) this.spawn(d);
    this.onChange?.();
  }

  /** Pin the given endpoints (model-local coordinates) as a new measurement. */
  add(a: THREE.Vector3, b: THREE.Vector3): void {
    const d: StoredMeasurement = {
      id: genId(),
      ax: a.x,
      ay: a.y,
      az: a.z,
      bx: b.x,
      by: b.y,
      bz: b.z,
    };
    this.spawn(d);
    this.scheduleSave();
    this.onChange?.();
  }

  // --- List panel API ------------------------------------------------------

  getItems(): MeasurementItem[] {
    return this.items.map((i) => ({ id: i.data.id, text: i.text }));
  }

  /** Pan the camera to a measurement's midpoint and flash its label. */
  focus(id: string): void {
    const live = this.items.find((i) => i.data.id === id);
    if (!live) return;
    const mid = live.a.clone().add(live.b).multiplyScalar(0.5);
    this.controller.lookAtPoint(this.controller.localToWorld(mid));
    live.label.el.addClass("is-flash");
    window.setTimeout(() => live.label.el.removeClass("is-flash"), 900);
  }

  removeById(id: string): void {
    const live = this.items.find((i) => i.data.id === id);
    if (live) this.remove(live);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    for (const live of this.items) this.applyVisual(live);
  }

  isVisible(): boolean {
    return this.visible;
  }

  /** Restrict visible measurements to those touching `kept` (isolate). */
  setIsolate(kept: THREE.Object3D | null): void {
    if (!kept) {
      this.isolateBox = null;
    } else {
      const box = new THREE.Box3().setFromObject(kept);
      const pad = box.getSize(new THREE.Vector3()).length() * 0.01 || 1e-4;
      box.expandByScalar(pad);
      this.isolateBox = box;
    }
    for (const live of this.items) this.applyVisual(live);
  }

  private matchesIsolate(live: Live): boolean {
    if (!this.isolateBox) return true;
    const aw = this.controller.localToWorld(live.a);
    const bw = this.controller.localToWorld(live.b);
    return this.isolateBox.containsPoint(aw) || this.isolateBox.containsPoint(bw);
  }

  private applyVisual(live: Live): void {
    const shown = this.visible && this.matchesIsolate(live);
    live.graphic.visible = shown;
    live.label.el.toggleClass("is-hidden", !shown);
  }

  private spawn(d: StoredMeasurement): Live {
    const a = new THREE.Vector3(d.ax, d.ay, d.az);
    const b = new THREE.Vector3(d.bx, d.by, d.bz);
    const graphic = this.controller.addPersistentMeasurement(a, b);

    const el = activeDocument.createElement("div");
    el.className = "step-viewer-mpinned";

    const text = activeDocument.createElement("span");
    text.className = "step-viewer-mpinned-text";
    text.textContent = formatMm(a.distanceTo(b));

    const del = activeDocument.createElement("button");
    del.className = "step-viewer-mpinned-del";
    del.setAttribute("aria-label", "Delete measurement");
    del.textContent = "×";

    el.appendChild(text);
    el.appendChild(del);

    const mid = a.clone().add(b).multiplyScalar(0.5);
    const distText = formatMm(a.distanceTo(b));
    const label = this.labelLayer.add(
      el,
      () => this.controller.localToWorld(mid),
      null,
      () => distText,
    );
    const live: Live = { data: d, graphic, label, a, b, text: distText };

    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      this.remove(live);
    });

    this.items.push(live);
    this.applyVisual(live);
    return live;
  }

  private remove(live: Live): void {
    this.controller.removePersistentMeasurement(live.graphic);
    live.label.remove();
    const i = this.items.indexOf(live);
    if (i >= 0) this.items.splice(i, 1);
    this.scheduleSave();
    this.onChange?.();
  }

  private scheduleSave(): void {
    if (this.saveTimer != null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.store.set(
        this.path,
        this.items.map((i) => i.data),
      );
    }, 400);
  }

  dispose(): void {
    if (this.saveTimer != null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      void this.store.set(
        this.path,
        this.items.map((i) => i.data),
      );
    }
    for (const live of this.items) {
      this.controller.removePersistentMeasurement(live.graphic);
      live.label.remove();
    }
    this.items = [];
  }
}

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
