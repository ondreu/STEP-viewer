import { Plugin } from "obsidian";
import { OcctResult } from "../types";
import { stepToThree } from "./StepToThree";
import { ViewerController } from "./ViewerController";
import { createToolbar, iconButton } from "../ui/Toolbar";
import { createTreePanel } from "../ui/TreePanel";
import { PartInfoPanel } from "../ui/PartInfoPanel";
import { ViewCube } from "../ui/ViewCube";
import { LabelLayer, LabelHandle } from "../ui/LabelLayer";
import { AnnotationLayer } from "../ui/AnnotationLayer";
import { createAnnotationsPanel } from "../ui/AnnotationsPanel";
import { AnnotationStore } from "../annotations/AnnotationStore";

export interface MountOptions {
  plugin: Plugin;
  /** STEP file path — the key for annotation persistence. */
  filePath: string;
}

export interface ViewerHandle {
  controller: ViewerController;
  dispose(): void;
}

/**
 * Build the full interactive viewer into `host` from a parsed occt result:
 * controller, toolbar, view cube + roll arrows, structure tree, hover info,
 * measurement labels and annotations. Shared by the full StepView and note
 * embeds so both behave identically.
 */
export function mountViewer(
  host: HTMLElement,
  result: OcctResult,
  opts: MountOptions,
): ViewerHandle {
  const { group, tree } = stepToThree(result);

  const controller = new ViewerController(host);
  controller.setModel(group);

  const labelLayer = new LabelLayer(host);

  // Measurement readout (bottom-left) + number labels beside the lines.
  const readout = host.createDiv({ cls: "step-viewer-measure-readout" });
  readout.hide();
  controller.onMeasureUpdate = (text) => {
    if (text == null) {
      readout.setText("");
      readout.hide();
    } else {
      readout.setText(text);
      readout.show();
    }
  };
  let measureLabels: LabelHandle[] = [];
  controller.onMeasureLabels = (labels) => {
    for (const h of measureLabels) h.remove();
    measureLabels = labels.map((l) => {
      const el = activeDocument.createElement("div");
      el.className = "step-viewer-mlabel";
      el.textContent = l.text;
      el.style.color = `#${l.color.toString(16).padStart(6, "0")}`;
      const pos = l.pos.clone();
      return labelLayer.add(el, () => pos);
    });
  };

  // Left rail stacks the collapsible side panels (tree, annotations).
  const leftRail = host.createDiv({ cls: "step-viewer-left" });

  // Structure-tree panel, hidden until toggled.
  const treePanel = createTreePanel(leftRail, tree, controller);
  treePanel.el.toggle(false);

  // Part-info panel (bottom-right), driven by hover; also syncs the tree.
  const info = new PartInfoPanel(host);
  controller.onHover = (part) => {
    info.update(part);
    treePanel.reveal(part?.object ?? null);
  };

  // Annotations pinned to the model, persisted per file path.
  const annotations = new AnnotationLayer(
    controller,
    labelLayer,
    new AnnotationStore(opts.plugin),
    opts.filePath,
  );
  controller.onAnnotate = ({ local, part }) => annotations.addAt(local, part);

  // Annotations list panel (hidden until toggled), kept in sync with the layer.
  const annotsPanel = createAnnotationsPanel(leftRail, annotations);
  annotsPanel.el.toggle(false);
  annotations.onChange = () => annotsPanel.render();
  void annotations.load();

  // Right-side rail: view cube, roll arrows, toolbar.
  const rail = host.createDiv({ cls: "step-viewer-rail" });
  const cube = new ViewCube(rail, {
    getOrientation: () => {
      const cam = controller.getCamera();
      return {
        dir: cam.position.clone().sub(controller.getTarget()).normalize(),
        up: cam.up.clone(),
      };
    },
    onSelect: (dir) => controller.setViewDirection(dir),
  });

  const roll = rail.createDiv({ cls: "step-viewer-roll" });
  iconButton(roll, "rotate-ccw", "Rotate view 90° left", () => controller.rollView(-1));
  iconButton(roll, "rotate-cw", "Rotate view 90° right", () => controller.rollView(1));

  createToolbar(rail, controller, {
    treeInitiallyOpen: false,
    onToggleTree: () => {
      const open = !treePanel.el.isShown();
      treePanel.el.toggle(open);
      return open;
    },
    annotationsInitiallyOpen: false,
    onToggleAnnotations: () => {
      const open = !annotsPanel.el.isShown();
      annotsPanel.el.toggle(open);
      return open;
    },
  });

  // Per-frame overlays: keep the cube oriented and the labels positioned.
  controller.registerFrameCallback(() => cube.update());
  controller.registerFrameCallback(() =>
    labelLayer.update(controller.getCamera(), controller.getDomElement()),
  );
  controller.registerDisposable(cube);
  controller.registerDisposable(annotations);
  controller.registerDisposable(labelLayer);

  return {
    controller,
    dispose: () => {
      controller.dispose();
      host.empty();
    },
  };
}
