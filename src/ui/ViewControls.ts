import { setTooltip } from "obsidian";
import { ViewerController } from "../viewer/ViewerController";

export interface ControlHandle {
  el: HTMLElement;
  setOpen(open: boolean): void;
}

/**
 * Floating control for the section (clipping) plane: axis picker, flip, and a
 * position slider. Showing the panel enables clipping; hiding it disables it.
 */
export function createSectionControl(
  host: HTMLElement,
  controller: ViewerController,
): ControlHandle {
  const el = host.createDiv({ cls: "step-viewer-viewctl step-viewer-section-ctl" });
  el.hide();

  el.createSpan({ cls: "step-viewer-viewctl-title", text: "Section" });

  const axes = el.createDiv({ cls: "step-viewer-viewctl-axes" });
  const axisBtns: Record<string, HTMLElement> = {};
  (["x", "y", "z"] as const).forEach((axis) => {
    const b = axes.createEl("button", {
      cls: "step-viewer-btn clickable-icon step-viewer-viewctl-axis",
      text: axis.toUpperCase(),
    });
    b.addEventListener("click", () => {
      controller.setSectionAxis(axis);
      syncAxes();
    });
    axisBtns[axis] = b;
  });
  function syncAxes(): void {
    const cur = controller.getSectionAxis();
    for (const a of ["x", "y", "z"]) axisBtns[a].toggleClass("is-active", a === cur);
  }

  const flip = el.createEl("button", {
    cls: "step-viewer-btn clickable-icon step-viewer-viewctl-flip",
    text: "Flip",
  });
  setTooltip(flip, "Flip the cut side");
  flip.addEventListener("click", () => {
    const next = !controller.isSectionFlipped();
    controller.setSectionFlip(next);
    flip.toggleClass("is-active", next);
  });

  // Toggle the in-model handle between dragging the cut and tilting it (arcs).
  const gizmo = el.createEl("button", {
    cls: "step-viewer-btn clickable-icon step-viewer-viewctl-gizmo",
    text: "Tilt",
  });
  setTooltip(gizmo, "Handle mode: drag to move the cut / tilt to rotate it");
  gizmo.addEventListener("click", () => {
    const mode = controller.toggleSectionGizmoMode();
    gizmo.toggleClass("is-active", mode === "rotate");
    gizmo.setText(mode === "rotate" ? "Move" : "Tilt");
  });

  const slider = el.createEl("input", {
    cls: "step-viewer-viewctl-slider",
    attr: { type: "range", min: "0", max: "1", step: "0.005", value: "0.5" },
  });
  setTooltip(slider, "Section position");
  slider.addEventListener("input", () => {
    controller.setSectionPosition(parseFloat(slider.value));
  });

  return {
    el,
    setOpen(open) {
      el.toggle(open);
      controller.setSectionEnabled(open);
      if (open) {
        syncAxes();
        flip.toggleClass("is-active", controller.isSectionFlipped());
        controller.setSectionPosition(parseFloat(slider.value));
      }
    },
  };
}

/**
 * Floating control for explode view: a single slider spreading the top-level
 * parts outward. Hiding the panel collapses the assembly back together.
 */
export function createExplodeControl(
  host: HTMLElement,
  controller: ViewerController,
): ControlHandle {
  const el = host.createDiv({ cls: "step-viewer-viewctl step-viewer-explode-ctl" });
  el.hide();

  el.createSpan({ cls: "step-viewer-viewctl-title", text: "Explode" });

  const slider = el.createEl("input", {
    cls: "step-viewer-viewctl-slider",
    attr: { type: "range", min: "0", max: "1", step: "0.01", value: "0" },
  });
  setTooltip(slider, "Explode amount");
  slider.addEventListener("input", () => {
    controller.setExplode(parseFloat(slider.value));
  });

  return {
    el,
    setOpen(open) {
      el.toggle(open);
      if (open) {
        controller.setExplode(parseFloat(slider.value));
      } else {
        slider.value = "0";
        controller.setExplode(0);
      }
    },
  };
}
