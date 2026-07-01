import { setIcon } from "obsidian";
import { StepTreeNode } from "../viewer/StepToThree";
import { ViewerController } from "../viewer/ViewerController";

/**
 * Collapsible structure-tree panel (design doc §1 extension — assembly
 * hierarchy from the STEP `root`/`children`).
 *
 * Each row has a visibility checkbox (toggles the THREE object) and a label
 * (click frames the camera on that part). The panel is an overlay on the left;
 * its visibility is toggled from the toolbar.
 */
export function createTreePanel(
  host: HTMLElement,
  tree: StepTreeNode,
  controller: ViewerController,
): HTMLElement {
  const panel = host.createDiv({ cls: "step-viewer-tree" });
  const header = panel.createDiv({ cls: "step-viewer-tree-header" });
  header.createSpan({ text: "Structure", cls: "step-viewer-tree-title" });

  const body = panel.createDiv({ cls: "step-viewer-tree-body" });
  renderNode(body, tree, controller, 0);
  return panel;
}

function renderNode(
  container: HTMLElement,
  node: StepTreeNode,
  controller: ViewerController,
  depth: number,
): void {
  const hasChildren = node.children.length > 0;

  const row = container.createDiv({ cls: "step-viewer-tree-row" });
  row.style.paddingLeft = `${depth * 14 + 4}px`;

  // Expand / collapse caret (only when there are children).
  const caret = row.createSpan({ cls: "step-viewer-tree-caret" });
  let childWrap: HTMLElement | null = null;
  if (hasChildren) {
    setIcon(caret, "chevron-down");
    caret.addEventListener("click", (e) => {
      e.stopPropagation();
      const collapsed = caret.hasClass("is-collapsed");
      caret.toggleClass("is-collapsed", !collapsed);
      setIcon(caret, collapsed ? "chevron-down" : "chevron-right");
      childWrap?.toggle(collapsed);
    });
  }

  // Visibility checkbox.
  const cb = row.createEl("input", {
    type: "checkbox",
    cls: "step-viewer-tree-check",
  });
  cb.checked = node.object.visible;
  cb.addEventListener("click", (e) => e.stopPropagation());
  cb.addEventListener("change", () => {
    node.object.visible = cb.checked;
  });

  // Label — click frames the camera on this part.
  const label = row.createSpan({
    cls: "step-viewer-tree-label",
    text: node.name,
  });
  label.addEventListener("click", () => controller.focusObject(node.object));

  if (hasChildren) {
    childWrap = container.createDiv({ cls: "step-viewer-tree-children" });
    for (const child of node.children) {
      renderNode(childWrap, child, controller, depth + 1);
    }
  }
}
