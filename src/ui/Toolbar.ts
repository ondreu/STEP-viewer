import { setIcon, setTooltip } from "obsidian";
import { ViewerController } from "../viewer/ViewerController";

export interface ToolbarOptions {
  /** Toggle the structure-tree panel; returns the new open state. */
  onToggleTree: () => boolean;
  treeInitiallyOpen: boolean;
}

/**
 * Small overlay toolbar in the corner of the viewer (design doc §8):
 * Reset camera, Wireframe, Edges, Transparency, Measure, Structure tree.
 *
 * Buttons reflect current state and toggle the `is-active` class so styles.css
 * can highlight active toggles.
 */
export function createToolbar(
  host: HTMLElement,
  controller: ViewerController,
  opts: ToolbarOptions,
): HTMLElement {
  const bar = host.createDiv({ cls: "step-viewer-toolbar" });

  makeButton(bar, "rotate-ccw", "Reset camera", () => {
    controller.resetCamera();
  });

  const wireBtn = makeButton(bar, "grid", "Toggle wireframe", () => {
    wireBtn.toggleClass("is-active", controller.toggleWireframe());
  });
  wireBtn.toggleClass("is-active", controller.isWireframe());

  const edgeBtn = makeButton(bar, "box", "Toggle edges", () => {
    edgeBtn.toggleClass("is-active", controller.toggleEdges());
  });
  edgeBtn.toggleClass("is-active", controller.isEdgesVisible());

  const transpBtn = makeButton(bar, "blend", "Toggle transparency", () => {
    transpBtn.toggleClass("is-active", controller.toggleTransparency());
  });
  transpBtn.toggleClass("is-active", controller.isTransparent());

  const measureBtn = makeButton(
    bar,
    "ruler",
    "Measure distance (approximate)",
    () => {
      measureBtn.toggleClass("is-active", controller.toggleMeasure());
    },
  );
  measureBtn.toggleClass("is-active", controller.isMeasuring());

  const snapBtn = makeButton(
    bar,
    "magnet",
    "Snap measurement to corners / edges",
    () => {
      snapBtn.toggleClass("is-active", controller.toggleSnap());
    },
  );
  snapBtn.toggleClass("is-active", controller.isSnapping());

  const treeBtn = makeButton(bar, "list-tree", "Toggle structure tree", () => {
    treeBtn.toggleClass("is-active", opts.onToggleTree());
  });
  treeBtn.toggleClass("is-active", opts.treeInitiallyOpen);

  return bar;
}

function makeButton(
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
