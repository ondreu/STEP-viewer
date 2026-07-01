import { setIcon, setTooltip } from "obsidian";
import { ViewerController } from "../viewer/ViewerController";

/**
 * Small overlay toolbar in the corner of the viewer (design doc §8):
 * Reset camera, Wireframe on/off, Edges on/off.
 *
 * Buttons reflect current controller state and toggle the `is-active` class so
 * styles.css can highlight active toggles.
 */
export function createToolbar(
  host: HTMLElement,
  controller: ViewerController,
): HTMLElement {
  const bar = host.createDiv({ cls: "step-viewer-toolbar" });

  makeButton(bar, "rotate-ccw", "Reset camera", () => {
    controller.resetCamera();
  });

  const wireBtn = makeButton(bar, "grid", "Toggle wireframe", () => {
    const on = controller.toggleWireframe();
    wireBtn.toggleClass("is-active", on);
  });
  wireBtn.toggleClass("is-active", controller.isWireframe());

  const edgeBtn = makeButton(bar, "box", "Toggle edges", () => {
    const on = controller.toggleEdges();
    edgeBtn.toggleClass("is-active", on);
  });
  edgeBtn.toggleClass("is-active", controller.isEdgesVisible());

  return bar;
}

function makeButton(
  parent: HTMLElement,
  icon: string,
  tooltip: string,
  onClick: () => void,
): HTMLElement {
  const btn = parent.createEl("button", { cls: "step-viewer-btn clickable-icon" });
  setIcon(btn, icon);
  setTooltip(btn, tooltip, { placement: "left" });
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    onClick();
  });
  return btn;
}
