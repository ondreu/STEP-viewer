import * as THREE from "three";
import { ViewerController, formatMm } from "../viewer/ViewerController";
import { LabelLayer, LabelHandle } from "./LabelLayer";
import { MeasurementStore, StoredMeasurement } from "../annotations/MeasurementStore";

interface Live {
  data: StoredMeasurement;
  graphic: THREE.Object3D;
  label: LabelHandle;
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

  constructor(
    private controller: ViewerController,
    private labelLayer: LabelLayer,
    private store: MeasurementStore,
    private path: string,
  ) {}

  async load(): Promise<void> {
    const list = await this.store.get(this.path);
    for (const d of list) this.spawn(d);
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
    const label = this.labelLayer.add(el, () => this.controller.localToWorld(mid));
    const live: Live = { data: d, graphic, label };

    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      this.remove(live);
    });

    this.items.push(live);
    return live;
  }

  private remove(live: Live): void {
    this.controller.removePersistentMeasurement(live.graphic);
    live.label.remove();
    const i = this.items.indexOf(live);
    if (i >= 0) this.items.splice(i, 1);
    this.scheduleSave();
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
