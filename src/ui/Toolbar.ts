import { setIcon, setTooltip } from "obsidian";
import { ViewerController } from "../viewer/ViewerController";

export interface ToolbarOptions {
  /** Toggle the structure-tree panel; returns the new open state. */
  onToggleTree: () => boolean;
  treeInitiallyOpen: boolean;
}

/**
 * Overlay toolbar (design doc §8): fit camera, wireframe, edges, transparency,
 * measure, snap, annotate, structure tree. Buttons reflect current state; a
 * shared `sync()` re-reads the controller after every click so mutually
 * exclusive modes (measure vs annotate) stay consistent.
 */
export function createToolbar(
  host: HTMLElement,
  controller: ViewerController,
  opts: ToolbarOptions,
): HTMLElement {
  const bar = host.createDiv({ cls: "step-viewer-toolbar" });
  let treeOpen = opts.treeInitiallyOpen;

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
  const measure = iconButton(bar, "ruler", "Measure distance (approximate)", () => {
    controller.toggleMeasure();
    sync();
  });
  const snap = iconButton(bar, "magnet", "Snap measurement to corners / edges", () => {
    controller.toggleSnap();
    sync();
  });
  const annotate = iconButton(bar, "sticky-note", "Annotate: click a point to pin a note", () => {
    controller.toggleAnnotate();
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

  function sync(): void {
    wire.toggleClass("is-active", controller.isWireframe());
    edge.toggleClass("is-active", controller.isEdgesVisible());
    transp.toggleClass("is-active", controller.isTransparent());
    measure.toggleClass("is-active", controller.isMeasuring());
    snap.toggleClass("is-active", controller.isSnapping());
    annotate.toggleClass("is-active", controller.isAnnotating());
    tree.toggleClass("is-active", treeOpen);
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
