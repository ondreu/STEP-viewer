import { MarkdownRenderer, Plugin, setIcon, setTooltip } from "obsidian";
import * as THREE from "three";
import { ViewerController } from "../viewer/ViewerController";
import { LabelLayer, LabelHandle } from "./LabelLayer";
import { AnnotationStore, StoredAnnotation } from "../annotations/AnnotationStore";

// Default leader offset (screen px) applied the first time a note is switched
// to leader mode — placed up and to the right of the anchor.
const DEFAULT_LEADER_OFFSET = { x: 72, y: -56 };

/** Category colours a note can be tagged with (cycled from the swatch button). */
export const ANNOT_CATEGORIES: { color: string; label: string }[] = [
  { color: "#ffc531", label: "Note" },
  { color: "#e5484d", label: "Issue" },
  { color: "#30a46c", label: "OK" },
  { color: "#3b82f6", label: "Info" },
];
const DEFAULT_COLOR = ANNOT_CATEGORIES[0].color;

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
  color: string;
  link?: string;
}

/**
 * Notes pinned to points on the model (design doc §1 extension). Each note is a
 * pin (a child of the model group, so it follows rolls) plus an editable HTML
 * label projected by the LabelLayer. Notes render markdown in read state, can be
 * tagged with a category colour, and can link to another Obsidian note. Anchors
 * are stored in model-local coordinates and persisted per file path.
 */
export class AnnotationLayer {
  private items: Live[] = [];
  private saveTimer: number | null = null;
  private visible = true;
  private opacity = 1;
  private filter: string | null = null;
  /** Fired when annotations are added/removed/edited (drives the list panel). */
  onChange: (() => void) | null = null;

  constructor(
    private controller: ViewerController,
    private labelLayer: LabelLayer,
    private store: AnnotationStore,
    private path: string,
    private plugin: Plugin,
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
      color: i.data.color ?? DEFAULT_COLOR,
      link: i.data.link,
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

  /** Show only notes of the given category colour (null = show all). */
  setFilter(color: string | null): void {
    this.filter = color;
    for (const live of this.items) this.applyVisual(live);
  }

  getFilter(): string | null {
    return this.filter;
  }

  // --- Internals -----------------------------------------------------------

  private matchesFilter(d: StoredAnnotation): boolean {
    return !this.filter || (d.color ?? DEFAULT_COLOR) === this.filter;
  }

  private applyVisual(live: Live): void {
    const shown = this.visible && this.matchesFilter(live.data);
    live.pin.visible = shown;
    const mat = (live.pin as THREE.Mesh).material as THREE.MeshBasicMaterial;
    if (mat) {
      mat.color.set(live.data.color ?? DEFAULT_COLOR);
      mat.transparent = this.opacity < 1;
      mat.opacity = this.opacity;
    }
    live.label.el.toggleClass("is-hidden", !shown);
    live.label.el.style.opacity = String(this.opacity);
    live.label.el.style.setProperty("--annot-color", live.data.color ?? DEFAULT_COLOR);
    this.applyModes(live);
  }

  /** Reflect the per-note display options (hover-only / leader) onto the DOM. */
  private applyModes(live: Live): void {
    live.label.el.toggleClass("is-hover-only", !!live.data.hoverOnly);
    live.label.el.toggleClass("is-leader", !!live.data.leader);
  }

  private spawn(d: StoredAnnotation): Live {
    const pin = this.controller.addAnnotationPin(new THREE.Vector3(d.x, d.y, d.z));

    const el = activeDocument.createElement("div");
    el.className = "step-viewer-annot";

    // Collapsed marker shown in hover-only mode; the note expands on hover.
    const dot = activeDocument.createElement("span");
    dot.className = "step-viewer-annot-dot";
    el.appendChild(dot);

    const body = activeDocument.createElement("div");
    body.className = "step-viewer-annot-body";

    const tools = activeDocument.createElement("div");
    tools.className = "step-viewer-annot-tools";

    // Link chip (read state) + editable text + rendered markdown.
    const linkChip = activeDocument.createElement("a");
    linkChip.className = "step-viewer-annot-link";

    const linkRow = activeDocument.createElement("div");
    linkRow.className = "step-viewer-annot-linkrow";
    linkRow.hide();
    const linkInput = activeDocument.createElement("input");
    linkInput.type = "text";
    linkInput.placeholder = "Note to link, e.g. [[Design]]";
    linkInput.value = d.link ?? "";
    linkRow.appendChild(linkInput);

    const textEl = activeDocument.createElement("div");
    textEl.className = "step-viewer-annot-text";
    textEl.contentEditable = "true";
    textEl.textContent = d.text;
    textEl.dataset.placeholder = "Note… (markdown)";

    const renderEl = activeDocument.createElement("div");
    renderEl.className = "step-viewer-annot-render";

    body.appendChild(tools);
    body.appendChild(linkChip);
    body.appendChild(linkRow);
    body.appendChild(textEl);
    body.appendChild(renderEl);
    el.appendChild(body);

    const label = this.labelLayer.add(
      el,
      () => pin.getWorldPosition(new THREE.Vector3()),
      () =>
        d.leader
          ? { x: d.ox ?? DEFAULT_LEADER_OFFSET.x, y: d.oy ?? DEFAULT_LEADER_OFFSET.y }
          : null,
      () => d.text,
    );
    const live: Live = { data: d, pin, label, textEl };

    // Category colour: a swatch that cycles through the palette.
    const colorBtn = this.toolButton(tools, "", "Change category colour", () => {
      const cur = d.color ?? DEFAULT_COLOR;
      const idx = ANNOT_CATEGORIES.findIndex((c) => c.color === cur);
      const next = ANNOT_CATEGORIES[(idx + 1) % ANNOT_CATEGORIES.length];
      d.color = next.color;
      colorBtn.style.background = next.color;
      setTooltip(colorBtn, `Category: ${next.label}`, { placement: "top" });
      this.applyVisual(live);
      this.scheduleSave();
      this.onChange?.();
    });
    colorBtn.addClass("step-viewer-annot-swatch");
    colorBtn.style.background = d.color ?? DEFAULT_COLOR;

    // Link: toggle the input row; the chip (read state) opens the target.
    const linkBtn = this.toolButton(tools, "link", "Link to a note", () => {
      linkRow.toggle(!linkRow.isShown());
      if (linkRow.isShown()) linkInput.focus();
    });
    const syncLink = (): void => {
      const has = !!(d.link && d.link.trim());
      linkBtn.toggleClass("is-active", has);
      if (has) {
        linkChip.setText(`↗ ${d.link}`);
        linkChip.show();
      } else {
        linkChip.hide();
      }
    };
    linkInput.addEventListener("input", () => {
      d.link = linkInput.value.trim() || undefined;
      syncLink();
      this.scheduleSave();
      this.onChange?.();
    });
    linkInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") linkRow.hide();
    });
    linkInput.addEventListener("pointerdown", (e) => e.stopPropagation());
    linkChip.addEventListener("click", (e) => {
      e.stopPropagation();
      if (d.link) this.plugin.app.workspace.openLinkText(d.link, this.path, false);
    });
    syncLink();

    // Per-note display toggles: hover-only visibility, and leader placement.
    const hoverBtn = this.toolButton(tools, "eye", "Show only on hover", () => {
      d.hoverOnly = !d.hoverOnly;
      hoverBtn.toggleClass("is-active", !!d.hoverOnly);
      this.applyModes(live);
      this.scheduleSave();
    });
    hoverBtn.toggleClass("is-active", !!d.hoverOnly);

    const leaderBtn = this.toolButton(tools, "milestone", "Place off to the side (leader)", () => {
      d.leader = !d.leader;
      if (d.leader && d.ox == null && d.oy == null) {
        d.ox = DEFAULT_LEADER_OFFSET.x;
        d.oy = DEFAULT_LEADER_OFFSET.y;
      }
      leaderBtn.toggleClass("is-active", !!d.leader);
      this.applyModes(live);
      this.scheduleSave();
    });
    leaderBtn.toggleClass("is-active", !!d.leader);

    const del = activeDocument.createElement("button");
    del.className = "step-viewer-annot-del";
    del.setAttribute("aria-label", "Delete note");
    del.textContent = "×";
    tools.appendChild(del);

    // Markdown read/edit toggle.
    const enterEdit = (): void => {
      renderEl.hide();
      textEl.show();
      textEl.focus();
    };
    const commit = (): void => {
      d.text = textEl.textContent ?? "";
      if (d.text.trim()) {
        textEl.hide();
        void this.renderMarkdown(d.text, renderEl);
        renderEl.show();
      } else {
        renderEl.hide();
        textEl.show();
      }
    };
    // Initial state: rendered if there's text, editable if empty.
    if (d.text.trim()) {
      textEl.hide();
      void this.renderMarkdown(d.text, renderEl);
      renderEl.show();
    } else {
      renderEl.hide();
    }
    renderEl.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest("a");
      if (a) {
        e.preventDefault();
        e.stopPropagation();
        const href = a.getAttribute("data-href") || a.getAttribute("href") || "";
        if (href) this.plugin.app.workspace.openLinkText(href, this.path, false);
        return;
      }
      enterEdit();
    });
    textEl.addEventListener("input", () => {
      d.text = textEl.textContent ?? "";
      this.scheduleSave();
      this.onChange?.();
    });
    textEl.addEventListener("blur", commit);

    del.addEventListener("click", (e) => {
      e.stopPropagation();
      this.remove(live);
    });

    this.wireDrag(el, textEl, d);

    this.items.push(live);
    this.applyVisual(live);
    return live;
  }

  private async renderMarkdown(md: string, el: HTMLElement): Promise<void> {
    el.empty();
    await MarkdownRenderer.render(this.plugin.app, md, el, this.path, this.plugin);
  }

  /** Small icon toggle inside a note's toolbar strip. */
  private toolButton(
    parent: HTMLElement,
    icon: string,
    tooltip: string,
    onClick: () => void,
  ): HTMLElement {
    const btn = activeDocument.createElement("button");
    btn.className = "step-viewer-annot-tool clickable-icon";
    if (icon) setIcon(btn, icon);
    setTooltip(btn, tooltip, { placement: "top" });
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  /**
   * Pointer handling for a note. Always swallows canvas gestures (so editing
   * doesn't orbit the model); in leader mode, dragging the note (not the text or
   * buttons) moves it and stores the new offset.
   */
  private wireDrag(el: HTMLElement, textEl: HTMLElement, d: StoredAnnotation): void {
    let drag: { x: number; y: number; ox: number; oy: number } | null = null;

    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); // never reaches the canvas (orbit / new annotation)
      if (!d.leader) return;
      const target = e.target as HTMLElement;
      if (target === textEl || textEl.contains(target)) return; // allow editing
      if (target.closest("button") || target.closest("input") || target.closest("a")) return;
      drag = {
        x: e.clientX,
        y: e.clientY,
        ox: d.ox ?? DEFAULT_LEADER_OFFSET.x,
        oy: d.oy ?? DEFAULT_LEADER_OFFSET.y,
      };
      el.setPointerCapture(e.pointerId);
      el.addClass("is-dragging");
    });
    el.addEventListener("pointermove", (e) => {
      if (!drag) return;
      d.ox = drag.ox + (e.clientX - drag.x);
      d.oy = drag.oy + (e.clientY - drag.y);
    });
    const end = (e: PointerEvent): void => {
      if (!drag) return;
      drag = null;
      el.removeClass("is-dragging");
      el.releasePointerCapture?.(e.pointerId);
      this.scheduleSave();
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
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
