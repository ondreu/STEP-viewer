import { setIcon, setTooltip } from "obsidian";
import { MeasureMode, ViewerController } from "../viewer/ViewerController";

export interface ToolbarOptions {
  /** Toggle the structure-tree panel; returns the new open state. */
  onToggleTree: () => boolean;
  treeInitiallyOpen: boolean;
  /** Toggle the annotations list panel; returns the new open state. */
  onToggleAnnotations: () => boolean;
  annotationsInitiallyOpen: boolean;
  /** Toggle the section-plane control; returns the new open state. */
  onToggleSection: () => boolean;
  /** Toggle the explode control; returns the new open state. */
  onToggleExplode: () => boolean;
  /** Capture a PNG screenshot of the current view. */
  onScreenshot: () => void;
}

const MEASURE_MODES: { mode: MeasureMode; glyph: string; tip: string }[] = [
  { mode: "distance", glyph: "↔", tip: "Distance — two points" },
  { mode: "angle", glyph: "∠", tip: "Angle — three points (corner 2nd)" },
  { mode: "radius", glyph: "⌀", tip: "Radius / diameter — three points on a circle" },
  { mode: "thickness", glyph: "⇳", tip: "Thickness — a point on a face (through the solid)" },
  { mode: "point-face", glyph: "⊥", tip: "Point → face perpendicular distance" },
  { mode: "face-face", glyph: "∥", tip: "Face → face distance" },
];

/**
 * Overlay toolbar (design doc §8): fit, wireframe, edges, transparency,
 * projection, section, explode, measure (+ type strip), snap, annotate,
 * isolate, screenshot, annotations, structure tree. Buttons reflect current
 * state; a shared `sync()` re-reads the controller after every click so
 * mutually exclusive modes stay consistent.
 */
export function createToolbar(
  host: HTMLElement,
  controller: ViewerController,
  opts: ToolbarOptions,
): HTMLElement {
  const bar = host.createDiv({ cls: "step-viewer-toolbar" });
  let treeOpen = opts.treeInitiallyOpen;
  let annotsOpen = opts.annotationsInitiallyOpen;
  let sectionOpen = false;
  let explodeOpen = false;

  const wire = iconButton(bar, "grid", "Toggle wireframe", () => {
    controller.toggleWireframe();
    sync();
  });
  const edge = iconButton(bar, "box", "Toggle edges", () => {
    controller.toggleEdges();
    sync();
  });
  const transp = iconButton(bar, "blend", "Toggle transparency", () => {
    controller.toggleTransparency();
    sync();
  });
  const proj = iconButton(bar, "box-select", "Perspective / orthographic", () => {
    controller.toggleProjection();
    sync();
  });
  const section = iconButton(bar, "scissors", "Section plane", () => {
    sectionOpen = opts.onToggleSection();
    sync();
  });
  const explode = iconButton(bar, "move-3d", "Explode view", () => {
    explodeOpen = opts.onToggleExplode();
    sync();
  });
  const measure = iconButton(bar, "ruler", "Measure (choose a type below)", () => {
    controller.toggleMeasure();
    sync();
  });
  const snap = iconButton(bar, "magnet", "Snap measurement & annotations to corners / edges", () => {
    controller.toggleSnap();
    sync();
  });
  const annotate = iconButton(bar, "sticky-note", "Annotate: click a point to pin a note", () => {
    controller.toggleAnnotate();
    sync();
  });
  const isolate = iconButton(bar, "focus", "Isolate the selected part", () => {
    controller.toggleIsolate();
    sync();
  });
  iconButton(bar, "camera", "Screenshot to PNG", () => {
    opts.onScreenshot();
  });
  const annots = iconButton(bar, "messages-square", "Toggle annotations list", () => {
    annotsOpen = opts.onToggleAnnotations();
    sync();
  });
  const tree = iconButton(bar, "list-tree", "Toggle structure tree", () => {
    treeOpen = opts.onToggleTree();
    sync();
  });

  // Fit is first visually but declared last so it isn't part of the toggle row.
  const fit = iconButton(bar, "maximize", "Reset / fit camera", () => {
    controller.resetCamera();
  });
  bar.insertBefore(fit, bar.firstChild);

  // Measurement-type strip, shown only while measuring.
  const modeStrip = host.createDiv({ cls: "step-viewer-measure-modes" });
  const modeBtns = MEASURE_MODES.map(({ mode, glyph, tip }) => {
    const b = modeStrip.createEl("button", {
      cls: "step-viewer-btn clickable-icon step-viewer-mode-btn",
      text: glyph,
    });
    setTooltip(b, tip, { placement: "left" });
    b.addEventListener("click", () => {
      controller.setMeasureMode(mode);
      sync();
    });
    return { mode, el: b };
  });
  modeStrip.hide();

  function sync(): void {
    wire.toggleClass("is-active", controller.isWireframe());
    edge.toggleClass("is-active", controller.isEdgesVisible());
    transp.toggleClass("is-active", controller.isTransparent());
    proj.toggleClass("is-active", controller.isOrthographic());
    setTooltip(
      proj,
      controller.isOrthographic() ? "Switch to perspective" : "Switch to orthographic",
      { placement: "left" },
    );
    section.toggleClass("is-active", sectionOpen);
    explode.toggleClass("is-active", explodeOpen);
    measure.toggleClass("is-active", controller.isMeasuring());
    snap.toggleClass("is-active", controller.isSnapping());
    annotate.toggleClass("is-active", controller.isAnnotating());
    isolate.toggleClass("is-active", controller.isIsolated());
    annots.toggleClass("is-active", annotsOpen);
    tree.toggleClass("is-active", treeOpen);

    modeStrip.toggle(controller.isMeasuring());
    const cur = controller.getMeasureMode();
    for (const { mode, el } of modeBtns) el.toggleClass("is-active", mode === cur);
  }
  sync();

  return bar;
}

/** Shared icon-button factory (also used for the roll arrows). */
export function iconButton(
  parent: HTMLElement,
  icon: string,
  tooltip: string,
  onClick: () => void,
): HTMLElement {
  const btn = parent.createEl("button", {
    cls: "step-viewer-btn clickable-icon",
  });
  setIcon(btn, icon);
  setTooltip(btn, tooltip, { placement: "left" });
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    onClick();
  });
  return btn;
}
