import { setIcon, setTooltip } from "obsidian";
import { AnnotationLayer, ANNOT_CATEGORIES } from "./AnnotationLayer";
import { MeasurementLayer } from "./MeasurementLayer";
import { makeResizable } from "./resizable";

export interface AnnotationsPanelHandle {
  el: HTMLElement;
  render(): void;
}

/**
 * Side panel listing all annotations (text + the part each is attached to) and
 * all pinned measurements, with a show/hide toggle and an opacity slider for the
 * annotations in the 3D view. Clicking a row pans the camera to that note /
 * measurement; each row can be deleted.
 */
export function createAnnotationsPanel(
  host: HTMLElement,
  layer: AnnotationLayer,
  measurements: MeasurementLayer,
): AnnotationsPanelHandle {
  const panel = host.createDiv({ cls: "step-viewer-annots" });

  const header = panel.createDiv({ cls: "step-viewer-annots-header" });
  header.createSpan({ text: "Annotations", cls: "step-viewer-tree-title" });

  const eye = header.createEl("button", { cls: "step-viewer-btn clickable-icon" });
  const syncEye = () => {
    const shown = layer.isVisible();
    setIcon(eye, shown ? "eye" : "eye-off");
    setTooltip(eye, shown ? "Hide annotations & measurements" : "Show annotations & measurements");
    eye.toggleClass("is-active", !shown);
  };
  eye.addEventListener("click", () => {
    // One toggle governs both notes and pinned measurements in the 3D view.
    const next = !layer.isVisible();
    layer.setVisible(next);
    measurements.setVisible(next);
    syncEye();
  });
  syncEye();

  // Opacity slider for the annotations.
  const opacity = header.createEl("input", {
    cls: "step-viewer-annots-opacity",
    attr: { type: "range", min: "0.2", max: "1", step: "0.05" },
  });
  opacity.value = String(layer.getOpacity());
  setTooltip(opacity, "Annotation opacity");
  opacity.addEventListener("input", () => {
    layer.setOpacity(parseFloat(opacity.value));
  });

  // Category filter chips: "All" plus one swatch per category.
  const filterRow = panel.createDiv({ cls: "step-viewer-annots-filter" });
  const allChip = filterRow.createEl("button", {
    cls: "step-viewer-annots-chip is-active",
    text: "All",
  });
  const chips: { color: string | null; el: HTMLElement }[] = [
    { color: null, el: allChip },
  ];
  for (const cat of ANNOT_CATEGORIES) {
    const chip = filterRow.createEl("button", { cls: "step-viewer-annots-chip" });
    chip.style.background = cat.color;
    setTooltip(chip, cat.label);
    chips.push({ color: cat.color, el: chip });
  }
  function syncChips(): void {
    const cur = layer.getFilter();
    for (const c of chips) c.el.toggleClass("is-active", c.color === cur);
  }
  for (const c of chips) {
    c.el.addEventListener("click", () => {
      layer.setFilter(c.color);
      syncChips();
      render();
    });
  }

  const body = panel.createDiv({ cls: "step-viewer-annots-body" });

  function render(): void {
    body.empty();
    const filter = layer.getFilter();
    const items = layer.getItems().filter((i) => !filter || i.color === filter);
    // Measurements have no category, so they only show under the "All" filter.
    const measures = filter ? [] : measurements.getItems();

    if (items.length === 0 && measures.length === 0) {
      body.createDiv({
        cls: "step-viewer-annots-empty",
        text: filter
          ? "No annotations in this category."
          : "Nothing yet. Use annotate mode to add a note, or measure to pin one.",
      });
      return;
    }

    for (const item of items) {
      const row = body.createDiv({ cls: "step-viewer-annots-row" });
      const dot = row.createEl("button", { cls: "step-viewer-annots-dot" });
      dot.style.background = item.color;
      setTooltip(dot, "Change colour");
      dot.addEventListener("click", (e) => {
        e.stopPropagation();
        openColorPopover(dot, item.color, (c) => layer.setColor(item.id, c));
      });
      const main = row.createDiv({ cls: "step-viewer-annots-main" });
      main.createDiv({
        cls: "step-viewer-annots-text",
        text: item.text.trim() || "(empty note)",
      });
      main.createDiv({
        cls: "step-viewer-annots-part",
        text: item.link ? `↗ ${item.link}` : item.part || "—",
      });
      main.addEventListener("click", () => layer.focus(item.id));

      const del = row.createEl("button", {
        cls: "step-viewer-btn clickable-icon step-viewer-annots-del",
      });
      setIcon(del, "trash-2");
      setTooltip(del, "Delete annotation");
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        layer.removeById(item.id);
      });
    }

    if (measures.length > 0) {
      body.createDiv({
        cls: "step-viewer-annots-subhead",
        text: `Measurements (${measures.length})`,
      });
      for (const m of measures) {
        const row = body.createDiv({ cls: "step-viewer-annots-row" });
        const dot = row.createSpan({ cls: "step-viewer-annots-dot step-viewer-annots-mdot" });
        setIcon(dot, "ruler");
        const main = row.createDiv({ cls: "step-viewer-annots-main" });
        main.createDiv({ cls: "step-viewer-annots-text", text: m.text });
        main.addEventListener("click", () => measurements.focus(m.id));

        const del = row.createEl("button", {
          cls: "step-viewer-btn clickable-icon step-viewer-annots-del",
        });
        setIcon(del, "trash-2");
        setTooltip(del, "Delete measurement");
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          measurements.removeById(m.id);
        });
      }
    }
  }

  makeResizable(panel);

  render();
  return { el: panel, render };
}

/**
 * Popover of category swatches + a custom colour picker, anchored under `dot`.
 * Calls `onPick` with the chosen hex (live for the custom picker). Appended to
 * the document body (fixed-positioned) so the panel's scroll clipping and
 * re-renders don't hide or clip it. Closes on an outside click.
 */
function openColorPopover(
  dot: HTMLElement,
  current: string,
  onPick: (color: string) => void,
): void {
  activeDocument.querySelectorAll(".step-viewer-annots-pop").forEach((e) => e.remove());

  const pop = activeDocument.body.createDiv({ cls: "step-viewer-annots-pop" });
  const rect = dot.getBoundingClientRect();
  pop.style.left = `${rect.left}px`;
  pop.style.top = `${rect.bottom + 4}px`;

  for (const cat of ANNOT_CATEGORIES) {
    const sw = pop.createEl("button", { cls: "step-viewer-annot-palette-swatch" });
    sw.style.background = cat.color;
    setTooltip(sw, cat.label);
    sw.addEventListener("click", (e) => {
      e.stopPropagation();
      onPick(cat.color);
      pop.remove();
    });
  }

  const custom = pop.createEl("input", {
    cls: "step-viewer-annot-palette-custom",
    attr: { type: "color", value: /^#[0-9a-f]{6}$/i.test(current) ? current : ANNOT_CATEGORIES[0].color },
  });
  setTooltip(custom, "Custom colour");
  custom.addEventListener("click", (e) => e.stopPropagation());
  custom.addEventListener("input", () => onPick(custom.value));
  custom.addEventListener("change", () => pop.remove());

  // Close on any click outside the popover (capture so it beats other handlers).
  const close = (e: Event): void => {
    if (!pop.contains(e.target as Node)) {
      pop.remove();
      activeDocument.removeEventListener("pointerdown", close, true);
    }
  };
  activeDocument.addEventListener("pointerdown", close, true);
}
