import { Component, MarkdownRenderer, Plugin, setIcon, setTooltip } from "obsidian";
import * as THREE from "three";
import { ViewerController } from "../viewer/ViewerController";
import { LabelLayer, LabelHandle } from "./LabelLayer";
import { AnnotationStore, StoredAnnotation } from "../annotations/AnnotationStore";

// Default leader offset (screen px) applied the first time a note is pulled out
// to the side — placed clearly up and to the right of the anchor.
const DEFAULT_LEADER_OFFSET = { x: 140, y: -96 };
// Pointer travel (px) before a press on a note becomes a drag rather than a click.
const DRAG_THRESHOLD = 4;

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
  // Owns the markdown-render child components so they're freed when this view
  // closes, not only when the plugin unloads.
  private mdComponent = new Component();
  /** Fired when annotations are added/removed/edited (drives the list panel). */
  onChange: (() => void) | null = null;

  constructor(
    private controller: ViewerController,
    private labelLayer: LabelLayer,
    private store: AnnotationStore,
    private path: string,
    private plugin: Plugin,
  ) {
    this.mdComponent.load();
  }

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
      // Screenshot caption: the rendered (plain) text, not the markdown source.
      () => renderEl.textContent || d.text,
    );
    const live: Live = { data: d, pin, label, textEl };

    // Category colour: a swatch that opens a palette popover to pick a colour.
    const palette = activeDocument.createElement("div");
    palette.className = "step-viewer-annot-palette";
    palette.hide();
    body.insertBefore(palette, linkChip);

    const colorBtn = this.toolButton(tools, "", "Category colour", () => {
      palette.toggle(!palette.isShown());
    });
    colorBtn.addClass("step-viewer-annot-swatch");
    const paintSwatch = (): void => {
      const cur = d.color ?? DEFAULT_COLOR;
      colorBtn.style.background = cur;
      const cat = ANNOT_CATEGORIES.find((c) => c.color === cur);
      setTooltip(colorBtn, `Category: ${cat?.label ?? "Note"}`, { placement: "top" });
    };
    for (const cat of ANNOT_CATEGORIES) {
      const sw = activeDocument.createElement("button");
      sw.className = "step-viewer-annot-palette-swatch";
      sw.style.background = cat.color;
      setTooltip(sw, cat.label, { placement: "top" });
      sw.addEventListener("click", (e) => {
        e.stopPropagation();
        d.color = cat.color;
        palette.hide();
        paintSwatch();
        this.applyVisual(live);
        this.scheduleSave();
        this.onChange?.();
      });
      palette.appendChild(sw);
    }
    paintSwatch();

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

    // Leader = pull the note off to the side with an arrow. Toggling on pulls it
    // out to the default offset; toggling off snaps it back onto the anchor.
    // (You can also just drag the note anywhere — that pulls it out too.)
    const leaderBtn = this.toolButton(tools, "milestone", "Pull note out to the side (or drag it)", () => {
      d.leader = !d.leader;
      if (d.leader) {
        d.ox = d.ox ?? DEFAULT_LEADER_OFFSET.x;
        d.oy = d.oy ?? DEFAULT_LEADER_OFFSET.y;
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
      // A click that concluded a drag (pull-out) must not also enter edit mode.
      if (el.dataset.dragged) {
        delete el.dataset.dragged;
        return;
      }
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

    this.wireDrag(el, textEl, live);

    this.items.push(live);
    this.applyVisual(live);
    return live;
  }

  private async renderMarkdown(md: string, el: HTMLElement): Promise<void> {
    el.empty();
    await MarkdownRenderer.render(this.plugin.app, md, el, this.path, this.mdComponent);
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
   * doesn't orbit the model). Dragging the note body (not the text, buttons,
   * link or input) pulls it off to the side: past a small threshold it turns on
   * leader mode automatically and follows the cursor, drawing the arrow back to
   * its anchor. A press that doesn't move stays a click (edit / open link).
   */
  private wireDrag(el: HTMLElement, textEl: HTMLElement, live: Live): void {
    const d = live.data;
    let press: { x: number; y: number; ox: number; oy: number } | null = null;
    let moved = false;

    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation(); // never reaches the canvas (orbit / new annotation)
      delete el.dataset.dragged;
      const target = e.target as HTMLElement;
      if (target === textEl || textEl.contains(target)) return; // allow editing
      if (target.closest("button") || target.closest("input") || target.closest("a")) return;
      press = {
        x: e.clientX,
        y: e.clientY,
        ox: d.leader ? d.ox ?? DEFAULT_LEADER_OFFSET.x : 0,
        oy: d.leader ? d.oy ?? DEFAULT_LEADER_OFFSET.y : 0,
      };
      moved = false;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!press) return;
      const dx = e.clientX - press.x;
      const dy = e.clientY - press.y;
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!moved) {
        moved = true;
        el.addClass("is-dragging");
        if (!d.leader) {
          d.leader = true; // dragging the note pulls it out with an arrow
          this.applyModes(live);
        }
      }
      d.ox = press.ox + dx;
      d.oy = press.oy + dy;
    });
    const end = (e: PointerEvent): void => {
      if (!press) return;
      el.releasePointerCapture?.(e.pointerId);
      if (moved) {
        el.removeClass("is-dragging");
        el.dataset.dragged = "1"; // suppress the click that follows a drag
        this.scheduleSave();
        this.onChange?.();
      }
      press = null;
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
    this.mdComponent.unload(); // free all rendered-markdown child components
  }
}

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
