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
  /** Export the selected part (or whole model) as an OBJ mesh file. */
  onExportObj: () => void;
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
  let treeOpen = opts.treeInitiallyOpen;
  let annotsOpen = opts.annotationsInitiallyOpen;
  let sectionOpen = false;
  let explodeOpen = false;

  // Each logical group is its own card, so the split reads clearly.
  const g1 = card(host);
  iconButton(g1, "maximize", "Reset / fit camera", () => controller.resetCamera());

  const g2 = card(host);
  const wire = iconButton(g2, "grid", "Toggle wireframe", () => {
    controller.toggleWireframe();
    sync();
  });
  const edge = iconButton(g2, "box", "Toggle edges", () => {
    controller.toggleEdges();
    sync();
  });
  const transp = iconButton(g2, "blend", "Toggle transparency", () => {
    controller.toggleTransparency();
    sync();
  });
  const proj = iconButton(g2, "box-select", "Perspective / orthographic", () => {
    controller.toggleProjection();
    sync();
  });

  const g3 = card(host);
  const section = iconButton(g3, "scissors", "Section plane", () => {
    sectionOpen = opts.onToggleSection();
    sync();
  });
  const explode = iconButton(g3, "move-3d", "Explode view", () => {
    explodeOpen = opts.onToggleExplode();
    sync();
  });

  const g4 = card(host);
  const measure = iconButton(g4, "ruler", "Measure (choose a type below)", () => {
    controller.toggleMeasure();
    sync();
  });
  const snap = iconButton(g4, "magnet", "Snap measurement & annotations to corners / edges", () => {
    controller.toggleSnap();
    sync();
  });
  const annotate = iconButton(g4, "sticky-note", "Annotate: click a point to pin a note", () => {
    controller.toggleAnnotate();
    sync();
  });

  const g5 = card(host);
  iconButton(g5, "camera", "Screenshot to PNG", () => opts.onScreenshot());
  iconButton(g5, "download", "Export selected part (or whole model) as OBJ", () =>
    opts.onExportObj(),
  );
  const annots = iconButton(g5, "messages-square", "Toggle annotations list", () => {
    annotsOpen = opts.onToggleAnnotations();
    sync();
  });
  const tree = iconButton(g5, "list-tree", "Toggle structure tree", () => {
    treeOpen = opts.onToggleTree();
    sync();
  });

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
    annots.toggleClass("is-active", annotsOpen);
    tree.toggleClass("is-active", treeOpen);

    modeStrip.toggle(controller.isMeasuring());
    const cur = controller.getMeasureMode();
    for (const { mode, el } of modeBtns) el.toggleClass("is-active", mode === cur);
  }
  sync();

  return g1;
}

/** A toolbar group rendered as its own card in the rail. */
function card(host: HTMLElement): HTMLElement {
  return host.createDiv({ cls: "step-viewer-toolbar" });
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
