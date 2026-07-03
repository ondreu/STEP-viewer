import { setTooltip } from "obsidian";
import { ViewerController } from "../viewer/ViewerController";

export interface ControlHandle {
  el: HTMLElement;
  setOpen(open: boolean): void;
}

/**
 * Floating control for the section (clipping) plane: axis picker and flip. The
 * cut is moved and tilted directly with the in-model handles (an arrow to slide
 * it along its normal, arcs to angle it). Showing the panel enables clipping;
 * hiding it disables it.
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

  // Tilt the cut off its axis with two static sliders (about the plane's two
  // in-plane axes). Sliders instead of a rotate gizmo: they stay put on screen
  // and can't be grabbed together with the in-model move arrow.
  const tilt = el.createDiv({ cls: "step-viewer-viewctl-tilt" });
  const makeTilt = (label: string): HTMLInputElement => {
    const row = tilt.createDiv({ cls: "step-viewer-viewctl-tilt-row" });
    row.createSpan({ cls: "step-viewer-viewctl-tilt-label", text: label });
    const s = row.createEl("input", {
      cls: "step-viewer-viewctl-slider",
      attr: { type: "range", min: "-90", max: "90", step: "1", value: "0" },
    });
    setTooltip(s, `Tilt the cut (${label})`);
    return s;
  };
  const tiltA = makeTilt("Tilt ↕");
  const tiltB = makeTilt("Tilt ↔");
  const applyTilt = (): void => {
    const deg = Math.PI / 180;
    controller.setSectionTilt(parseFloat(tiltA.value) * deg, parseFloat(tiltB.value) * deg);
  };
  tiltA.addEventListener("input", applyTilt);
  tiltB.addEventListener("input", applyTilt);

  return {
    el,
    setOpen(open) {
      el.toggle(open);
      controller.setSectionEnabled(open);
      if (open) {
        syncAxes();
        flip.toggleClass("is-active", controller.isSectionFlipped());
        // Start each session flat and centred; the arrow + tilt sliders take over.
        tiltA.value = "0";
        tiltB.value = "0";
        controller.setSectionTilt(0, 0);
        controller.setSectionPosition(0.5);
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
