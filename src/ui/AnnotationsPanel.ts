import { setIcon, setTooltip } from "obsidian";
import { AnnotationLayer, ANNOT_CATEGORIES } from "./AnnotationLayer";

export interface AnnotationsPanelHandle {
  el: HTMLElement;
  render(): void;
}

/**
 * Side panel listing all annotations (text + the part each is attached to),
 * with a show/hide toggle and an opacity slider for the annotations in the 3D
 * view. Clicking a row pans the camera to that note; each row can be deleted.
 */
export function createAnnotationsPanel(
  host: HTMLElement,
  layer: AnnotationLayer,
): AnnotationsPanelHandle {
  const panel = host.createDiv({ cls: "step-viewer-annots" });

  const header = panel.createDiv({ cls: "step-viewer-annots-header" });
  header.createSpan({ text: "Annotations", cls: "step-viewer-tree-title" });

  const eye = header.createEl("button", { cls: "step-viewer-btn clickable-icon" });
  const syncEye = () => {
    setIcon(eye, layer.isVisible() ? "eye" : "eye-off");
    setTooltip(eye, layer.isVisible() ? "Hide annotations" : "Show annotations");
    eye.toggleClass("is-active", !layer.isVisible());
  };
  eye.addEventListener("click", () => {
    layer.setVisible(!layer.isVisible());
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
    if (items.length === 0) {
      body.createDiv({
        cls: "step-viewer-annots-empty",
        text: filter
          ? "No annotations in this category."
          : "No annotations yet. Use annotate mode to add one.",
      });
      return;
    }
    for (const item of items) {
      const row = body.createDiv({ cls: "step-viewer-annots-row" });
      const dot = row.createSpan({ cls: "step-viewer-annots-dot" });
      dot.style.background = item.color;
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
  }

  render();
  return { el: panel, render };
}
