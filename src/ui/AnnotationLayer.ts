import * as THREE from "three";
import { ViewerController } from "../viewer/ViewerController";
import { LabelLayer, LabelHandle } from "./LabelLayer";
import { AnnotationStore, StoredAnnotation } from "../annotations/AnnotationStore";

interface Live {
  data: StoredAnnotation;
  pin: THREE.Object3D;
  label: LabelHandle;
  textEl: HTMLElement;
}

/**
 * Notes pinned to points on the model (design doc §1 extension). Each note is a
 * pin (a child of the model group, so it follows rolls) plus an editable HTML
 * label projected by the LabelLayer. Anchors are stored in model-local
 * coordinates and persisted per file path via AnnotationStore.
 */
export class AnnotationLayer {
  private items: Live[] = [];
  private saveTimer: number | null = null;

  constructor(
    private controller: ViewerController,
    private labelLayer: LabelLayer,
    private store: AnnotationStore,
    private path: string,
  ) {}

  async load(): Promise<void> {
    const list = await this.store.get(this.path);
    for (const d of list) this.spawn(d);
  }

  /** Called when the user clicks a model point in annotate mode. */
  addAt(local: THREE.Vector3, part: string): void {
    const d: StoredAnnotation = {
      id: genId(),
      x: local.x,
      y: local.y,
      z: local.z,
      text: "",
      part,
    };
    const live = this.spawn(d);
    live.textEl.focus();
    this.scheduleSave();
  }

  private spawn(d: StoredAnnotation): Live {
    const pin = this.controller.addAnnotationPin(new THREE.Vector3(d.x, d.y, d.z));

    const el = document.createElement("div");
    el.className = "step-viewer-annot";

    const del = document.createElement("button");
    del.className = "step-viewer-annot-del";
    del.setAttribute("aria-label", "Delete note");
    del.textContent = "×";

    const textEl = document.createElement("div");
    textEl.className = "step-viewer-annot-text";
    textEl.contentEditable = "true";
    textEl.textContent = d.text;
    textEl.dataset.placeholder = "Note…";

    el.appendChild(del);
    el.appendChild(textEl);

    const label = this.labelLayer.add(el, () =>
      pin.getWorldPosition(new THREE.Vector3()),
    );
    const live: Live = { data: d, pin, label, textEl };

    textEl.addEventListener("input", () => {
      d.text = textEl.textContent ?? "";
      this.scheduleSave();
    });
    // Don't let editing gestures reach the canvas (orbit / new annotation).
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      this.remove(live);
    });

    this.items.push(live);
    return live;
  }

  private remove(live: Live): void {
    this.controller.removeAnnotationPin(live.pin);
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
      // Flush the latest state on teardown.
      void this.store.set(
        this.path,
        this.items.map((i) => i.data),
      );
    }
    for (const live of this.items) {
      this.controller.removeAnnotationPin(live.pin);
      live.label.remove();
    }
    this.items = [];
  }
}

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
