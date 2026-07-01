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

/** Row data for the annotations list panel. */
export interface AnnotationItem {
  id: string;
  text: string;
  part: string;
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
  private visible = true;
  private opacity = 1;
  /** Fired when annotations are added/removed/edited (drives the list panel). */
  onChange: (() => void) | null = null;

  constructor(
    private controller: ViewerController,
    private labelLayer: LabelLayer,
    private store: AnnotationStore,
    private path: string,
  ) {}

  async load(): Promise<void> {
    const list = await this.store.get(this.path);
    for (const d of list) this.spawn(d);
    this.onChange?.();
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
    this.onChange?.();
  }

  // --- List panel API ------------------------------------------------------

  getItems(): AnnotationItem[] {
    return this.items.map((i) => ({
      id: i.data.id,
      text: i.data.text,
      part: i.data.part ?? "",
    }));
  }

  /** Pan the camera to an annotation and flash its label. */
  focus(id: string): void {
    const live = this.items.find((i) => i.data.id === id);
    if (!live) return;
    this.controller.lookAtPoint(live.pin.getWorldPosition(new THREE.Vector3()));
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

  setOpacity(o: number): void {
    this.opacity = o;
    for (const live of this.items) this.applyVisual(live);
  }

  getOpacity(): number {
    return this.opacity;
  }

  // --- Internals -----------------------------------------------------------

  private applyVisual(live: Live): void {
    live.pin.visible = this.visible;
    const mat = (live.pin as THREE.Mesh).material as THREE.MeshBasicMaterial;
    if (mat) {
      mat.transparent = this.opacity < 1;
      mat.opacity = this.opacity;
    }
    live.label.el.toggleClass("is-hidden", !this.visible);
    live.label.el.style.opacity = String(this.opacity);
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
      this.onChange?.();
    });
    // Don't let editing gestures reach the canvas (orbit / new annotation).
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
    this.controller.removeAnnotationPin(live.pin);
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
