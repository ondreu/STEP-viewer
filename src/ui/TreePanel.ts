import { setIcon } from "obsidian";
import * as THREE from "three";
import { StepTreeNode } from "../viewer/StepToThree";
import { ViewerController } from "../viewer/ViewerController";

export interface TreePanelHandle {
  el: HTMLElement;
  /** Highlight + scroll to the row for `object`, expanding ancestors. */
  reveal(object: THREE.Object3D | null): void;
}

interface RowEntry {
  row: HTMLElement;
  expandAncestors: () => void;
}

/**
 * Collapsible structure-tree panel (design doc §1 extension — assembly
 * hierarchy from the STEP `root`/`children`).
 *
 * Each row has a visibility checkbox (toggles the THREE object) and a label
 * (click frames the camera on that part). `reveal()` lets the 3D hover sync the
 * tree selection. The panel is an overlay on the left, toggled from the toolbar.
 */
export function createTreePanel(
  host: HTMLElement,
  tree: StepTreeNode,
  controller: ViewerController,
): TreePanelHandle {
  const panel = host.createDiv({ cls: "step-viewer-tree" });
  const header = panel.createDiv({ cls: "step-viewer-tree-header" });
  header.createSpan({ text: "Structure", cls: "step-viewer-tree-title" });

  const body = panel.createDiv({ cls: "step-viewer-tree-body" });

  const rows = new Map<THREE.Object3D, RowEntry>();
  renderNode(body, tree, controller, 0, [], rows);

  let current: HTMLElement | null = null;

  return {
    el: panel,
    reveal(object) {
      if (current) {
        current.removeClass("is-active");
        current = null;
      }
      if (!object) return;
      const entry = rows.get(object);
      if (!entry) return;
      entry.expandAncestors();
      entry.row.addClass("is-active");
      entry.row.scrollIntoView({ block: "nearest" });
      current = entry.row;
    },
  };
}

function renderNode(
  container: HTMLElement,
  node: StepTreeNode,
  controller: ViewerController,
  depth: number,
  ancestorExpanders: Array<() => void>,
  rows: Map<THREE.Object3D, RowEntry>,
): void {
  const hasChildren = node.children.length > 0;

  const row = container.createDiv({ cls: "step-viewer-tree-row" });
  row.style.paddingLeft = `${depth * 14 + 4}px`;

  const caret = row.createSpan({ cls: "step-viewer-tree-caret" });
  let childWrap: HTMLElement | null = null;

  // Expander that un-collapses this node's children (used to reveal descendants).
  const expandSelf = () => {
    if (!hasChildren || !childWrap) return;
    caret.removeClass("is-collapsed");
    setIcon(caret, "chevron-down");
    childWrap.show();
  };

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

  const cb = row.createEl("input", {
    type: "checkbox",
    cls: "step-viewer-tree-check",
  });
  cb.checked = node.object.visible;
  cb.addEventListener("click", (e) => e.stopPropagation());
  cb.addEventListener("change", () => {
    node.object.visible = cb.checked;
  });

  const label = row.createSpan({
    cls: "step-viewer-tree-label",
    text: node.name,
  });
  label.addEventListener("click", () => {
    controller.setSelected(node.object);
    controller.focusObject(node.object);
  });

  rows.set(node.object, {
    row,
    expandAncestors: () => ancestorExpanders.forEach((fn) => fn()),
  });

  if (hasChildren) {
    childWrap = container.createDiv({ cls: "step-viewer-tree-children" });
    const nextExpanders = [...ancestorExpanders, expandSelf];
    for (const child of node.children) {
      renderNode(childWrap, child, controller, depth + 1, nextExpanders, rows);
    }
  }
}
