import { setIcon, setTooltip } from "obsidian";
import * as THREE from "three";
import { StepTreeNode } from "../viewer/StepToThree";
import { ViewerController } from "../viewer/ViewerController";
import { makeResizable } from "./resizable";

export interface TreePanelHandle {
  el: HTMLElement;
  /** Highlight + scroll to the row for `object`, expanding ancestors. */
  reveal(object: THREE.Object3D | null): void;
}

export interface TreePanelOptions {
  /** Auto-measure the selected part's bounding box (brainstorm: en-masse). */
  onAutoMeasure?: () => void;
}

interface RowEntry {
  node: StepTreeNode;
  row: HTMLElement;
  childWrap: HTMLElement | null;
  checkbox: HTMLInputElement;
  depth: number;
  hasChildren: boolean;
  expandAncestors: () => void;
  setExpanded: (open: boolean) => void;
  isExpanded: () => boolean;
}

/**
 * Collapsible structure-tree panel (design doc §1 extension — assembly
 * hierarchy from the STEP `root`/`children`).
 *
 * Header controls expand/collapse all, toggle all visibility, and isolate the
 * selected part; a filter box narrows rows by name. Each row has a visibility
 * checkbox and a label (click selects + frames the part; hover highlights it).
 */
export function createTreePanel(
  host: HTMLElement,
  tree: StepTreeNode,
  controller: ViewerController,
  opts: TreePanelOptions = {},
): TreePanelHandle {
  const panel = host.createDiv({ cls: "step-viewer-tree" });

  const header = panel.createDiv({ cls: "step-viewer-tree-header" });
  header.createSpan({ text: "Structure", cls: "step-viewer-tree-title" });
  const count = header.createSpan({ cls: "step-viewer-tree-count" });

  const actions = header.createDiv({ cls: "step-viewer-tree-actions" });
  const rows = new Map<THREE.Object3D, RowEntry>();
  const entries: RowEntry[] = [];

  // Expand / collapse a single level across the whole tree per click (rather
  // than everything at once): expand opens the shallowest still-collapsed
  // level; collapse closes the deepest currently-open level.
  headerButton(actions, "chevrons-up-down", "Expand one level", () => {
    const depths = entries
      .filter((e) => e.hasChildren && !e.isExpanded())
      .map((e) => e.depth);
    if (!depths.length) return;
    const d = Math.min(...depths);
    for (const e of entries) if (e.hasChildren && e.depth === d) e.setExpanded(true);
  });
  headerButton(actions, "chevrons-down-up", "Collapse one level", () => {
    const depths = entries
      .filter((e) => e.hasChildren && e.isExpanded())
      .map((e) => e.depth);
    if (!depths.length) return;
    const d = Math.max(...depths);
    for (const e of entries) if (e.hasChildren && e.depth === d) e.setExpanded(false);
  });
  if (opts.onAutoMeasure) {
    headerButton(actions, "ruler", "Measure selected part's bounding box", () =>
      opts.onAutoMeasure?.(),
    );
  }
  let allVisible = true;
  const eyeBtn = headerButton(actions, "eye", "Hide all parts", () => {
    allVisible = !allVisible;
    for (const e of entries) {
      e.node.object.visible = allVisible;
      e.checkbox.checked = allVisible;
    }
    setIcon(eyeBtn, allVisible ? "eye" : "eye-off");
    setTooltip(eyeBtn, allVisible ? "Hide all parts" : "Show all parts");
    eyeBtn.toggleClass("is-active", !allVisible);
  });
  const isolateBtn = headerButton(actions, "focus", "Isolate the selected part", () => {
    const on = controller.toggleIsolate();
    isolateBtn.toggleClass("is-active", on);
  });

  // Name filter.
  const filter = panel.createEl("input", {
    cls: "step-viewer-tree-filter",
    attr: { type: "text", placeholder: "Filter parts…" },
  });

  const body = panel.createDiv({ cls: "step-viewer-tree-body" });
  renderNode(body, tree, controller, 0, [], rows, entries);

  // Part (leaf mesh) count.
  const leafCount = countLeaves(tree);
  count.setText(`${leafCount}`);
  setTooltip(count, `${leafCount} part${leafCount === 1 ? "" : "s"}`);

  filter.addEventListener("input", () => applyFilter(tree, rows, filter.value.trim().toLowerCase()));

  makeResizable(panel);

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

function headerButton(
  parent: HTMLElement,
  icon: string,
  tooltip: string,
  onClick: () => void,
): HTMLElement {
  const btn = parent.createEl("button", { cls: "step-viewer-btn clickable-icon" });
  setIcon(btn, icon);
  setTooltip(btn, tooltip);
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    onClick();
  });
  return btn;
}

function countLeaves(node: StepTreeNode): number {
  if (node.children.length === 0) return 1;
  return node.children.reduce((n, c) => n + countLeaves(c), 0);
}

/**
 * Show a row if the node's name matches, an ancestor matched (show its whole
 * subtree), or a descendant matches (show the path to it). Empty query resets.
 */
function applyFilter(
  tree: StepTreeNode,
  rows: Map<THREE.Object3D, RowEntry>,
  q: string,
): void {
  const visit = (node: StepTreeNode, ancestorMatch: boolean): boolean => {
    const entry = rows.get(node.object);
    const selfMatch = !q || node.name.toLowerCase().includes(q);
    let childMatch = false;
    for (const child of node.children) {
      childMatch = visit(child, ancestorMatch || selfMatch) || childMatch;
    }
    const subtreeMatch = selfMatch || childMatch;
    const visible = !q || subtreeMatch || ancestorMatch;
    if (entry) {
      entry.row.toggleClass("is-filtered-out", !visible);
      // While filtering, expand so matches are reachable; on clear, expand all.
      if (entry.childWrap) entry.setExpanded(true);
    }
    return subtreeMatch;
  };
  visit(tree, false);
}

function renderNode(
  container: HTMLElement,
  node: StepTreeNode,
  controller: ViewerController,
  depth: number,
  ancestorExpanders: Array<() => void>,
  rows: Map<THREE.Object3D, RowEntry>,
  entries: RowEntry[],
): void {
  const hasChildren = node.children.length > 0;

  const row = container.createDiv({ cls: "step-viewer-tree-row" });
  row.style.paddingLeft = `${depth * 14 + 4}px`;

  const caret = row.createSpan({ cls: "step-viewer-tree-caret" });
  let childWrap: HTMLElement | null = null;

  const setExpanded = (open: boolean): void => {
    if (!hasChildren || !childWrap) return;
    caret.toggleClass("is-collapsed", !open);
    setIcon(caret, open ? "chevron-down" : "chevron-right");
    childWrap.toggle(open);
  };
  const expandSelf = () => setExpanded(true);
  const isExpanded = () => hasChildren && !caret.hasClass("is-collapsed");

  if (hasChildren) {
    setIcon(caret, "chevron-down");
    caret.addEventListener("click", (e) => {
      e.stopPropagation();
      setExpanded(caret.hasClass("is-collapsed"));
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
  // Single click selects + highlights the part; double click frames it in the
  // view (matching double-click-to-focus on the model itself).
  label.addEventListener("click", () => {
    controller.setSelected(node.object);
  });
  label.addEventListener("dblclick", () => {
    controller.setSelected(node.object);
    controller.focusObject(node.object);
  });
  // Hover a row to highlight the part in 3D.
  row.addEventListener("mouseenter", () => controller.previewHighlight(node.object));
  row.addEventListener("mouseleave", () => controller.previewHighlight(null));

  const entry: RowEntry = {
    node,
    row,
    childWrap: null,
    checkbox: cb,
    depth,
    hasChildren,
    expandAncestors: () => ancestorExpanders.forEach((fn) => fn()),
    setExpanded,
    isExpanded,
  };
  rows.set(node.object, entry);
  entries.push(entry);

  if (hasChildren) {
    childWrap = container.createDiv({ cls: "step-viewer-tree-children" });
    entry.childWrap = childWrap;
    const nextExpanders = [...ancestorExpanders, expandSelf];
    for (const child of node.children) {
      renderNode(childWrap, child, controller, depth + 1, nextExpanders, rows, entries);
    }
  }
}
