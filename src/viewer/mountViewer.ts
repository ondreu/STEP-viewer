import { Notice, Plugin, setIcon, setTooltip } from "obsidian";
import * as THREE from "three";
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
import { MeasurementLayer } from "../ui/MeasurementLayer";
import { MeasurementStore } from "../annotations/MeasurementStore";
import { createSectionControl, createExplodeControl } from "../ui/ViewControls";
import { parseStepMeta } from "./StepMeta";
import { PartInfo } from "./ViewerController";

export interface MountOptions {
  plugin: Plugin;
  /** STEP file path — the key for annotation & measurement persistence. */
  filePath: string;
  /** Show saved annotations/notes (default true). Embeds may opt out. */
  showAnnotations?: boolean;
  /** Initial standard view: front/back/left/right/top/bottom/iso. */
  initialView?: string;
  /** Initial roll about the view axis, in 90° quarter turns. */
  initialRoll?: number;
  /** Raw STEP file text, used to extract material/metadata for the info card. */
  stepText?: string;
}

export interface ViewerHandle {
  controller: ViewerController;
  dispose(): void;
}

/** Standard-view directions (from target towards the camera), model-local. */
const VIEW_DIRS: Record<string, THREE.Vector3> = {
  front: new THREE.Vector3(0, 0, 1),
  back: new THREE.Vector3(0, 0, -1),
  left: new THREE.Vector3(-1, 0, 0),
  right: new THREE.Vector3(1, 0, 0),
  top: new THREE.Vector3(0, 1, 0),
  bottom: new THREE.Vector3(0, -1, 0),
  iso: new THREE.Vector3(1, 0.8, 1),
};

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
  const readoutText = readout.createSpan({ cls: "step-viewer-measure-text" });
  const keepBtn = readout.createEl("button", {
    cls: "step-viewer-btn clickable-icon step-viewer-measure-keep",
  });
  setIcon(keepBtn, "pin");
  setTooltip(keepBtn, "Pin this measurement", { placement: "top" });
  keepBtn.hide();
  readout.hide();
  controller.onMeasureUpdate = (text) => {
    if (text == null) {
      readoutText.setText("");
      readout.hide();
    } else {
      readoutText.setText(text);
      readout.show();
    }
  };
  controller.onMeasureCanKeep = (canKeep) => keepBtn.toggle(canKeep);
  let measureLabels: LabelHandle[] = [];
  controller.onMeasureLabels = (labels) => {
    for (const h of measureLabels) h.remove();
    measureLabels = labels.map((l) => {
      const el = activeDocument.createElement("div");
      el.className = "step-viewer-mlabel";
      el.textContent = l.text;
      el.style.color = `#${l.color.toString(16).padStart(6, "0")}`;
      const pos = l.pos.clone();
      return labelLayer.add(el, () => pos, null, () => l.text);
    });
  };

  // Left rail stacks the collapsible side panels (tree, annotations).
  const leftRail = host.createDiv({ cls: "step-viewer-left" });

  // Structure-tree panel, hidden until toggled.
  const treePanel = createTreePanel(leftRail, tree, controller, {
    onAutoMeasure: () => autoMeasure(),
  });
  treePanel.el.toggle(false);

  // Part-info panel (bottom-right). Hover only updates the info + transient
  // highlight; clicking a part selects it and reveals it in the tree (so the
  // tree doesn't jump around as the cursor moves over the model).
  const info = new PartInfoPanel(host);
  const meta = parseStepMeta(opts.stepText ?? "");
  // Fill in the material (from STEP metadata) before showing the info card.
  const enrich = (part: PartInfo | null): PartInfo | null => {
    if (part) part.material = meta.materialFor(part.name);
    return part;
  };
  controller.onHover = (part) => info.update(enrich(part));
  controller.onSelectPart = (part) => {
    info.update(enrich(part));
    treePanel.reveal(part?.object ?? null);
  };

  // Annotations pinned to the model, persisted per file path.
  const annotations = new AnnotationLayer(
    controller,
    labelLayer,
    new AnnotationStore(opts.plugin),
    opts.filePath,
    opts.plugin,
  );
  controller.onAnnotate = ({ local, part }) => annotations.addAt(local, part);

  // Pinned (persistent) measurements — parented to the model, persisted per file.
  const measurements = new MeasurementLayer(
    controller,
    labelLayer,
    new MeasurementStore(opts.plugin),
    opts.filePath,
  );

  // Annotations list panel (hidden until toggled), lists notes + measurements.
  const annotsPanel = createAnnotationsPanel(leftRail, annotations, measurements);
  annotsPanel.el.toggle(false);
  annotations.onChange = () => annotsPanel.render();
  measurements.onChange = () => annotsPanel.render();
  void annotations.load();
  void measurements.load();
  if (opts.showAnnotations === false) annotations.setVisible(false);

  // Isolating a part also hides annotations & measurements outside it.
  controller.onIsolateChange = (kept) => {
    annotations.setIsolate(kept);
    measurements.setIsolate(kept);
  };

  // Auto-measure: add the selected part's bounding-box dimensions (or the whole
  // model's, when nothing is selected) as pinned measurements in one action.
  function autoMeasure(): void {
    const target = controller.getSelected() ?? controller.getModel();
    if (!target) return;
    const segs = controller.autoMeasureSegments(target);
    if (!segs) {
      new Notice("Nothing to measure on that part.");
      return;
    }
    for (const s of segs) {
      measurements.add(controller.worldToLocal(s.a), controller.worldToLocal(s.b));
    }
    if (!annotsPanel.el.isShown()) new Notice(`Added ${segs.length} measurements.`);
  }

  // "Pin" the current A–B measurement: convert its world points to model-local
  // coordinates so the persistent copy follows rolls, then clear the transient.
  keepBtn.addEventListener("click", (e) => {
    e.preventDefault();
    const m = controller.getCompletedMeasurement();
    if (!m) return;
    measurements.add(controller.worldToLocal(m.a), controller.worldToLocal(m.b));
    controller.clearCurrentMeasurement();
  });

  // Floating view controls (bottom-centre), toggled from the toolbar.
  const viewCtls = host.createDiv({ cls: "step-viewer-viewctls" });
  const sectionCtl = createSectionControl(viewCtls, controller);
  const explodeCtl = createExplodeControl(viewCtls, controller);

  // Right-side rail: view cube, roll arrows, toolbar.
  const rail = host.createDiv({ cls: "step-viewer-rail" });
  const cube = new ViewCube(rail, {
    // Express the camera orientation in the *model's* frame so the cube stays
    // locked to the model. A 90° roll rotates the model (not the camera), so
    // without this the cube would desync from the geometry after a roll.
    getOrientation: () => {
      const cam = controller.getCamera();
      const inv = controller.getModelQuaternion().invert();
      const dir = cam.position.clone().sub(controller.getTarget()).normalize().applyQuaternion(inv);
      const up = cam.up.clone().applyQuaternion(inv);
      return { dir, up };
    },
    // Snapping to a standard view: undo any rolls first so the result is
    // axis-aligned and upright (the cube isn't left crooked), then look along
    // the clicked face direction (model-local == world after the reset).
    onSelect: (dir) => {
      controller.resetModelOrientation();
      controller.setViewDirection(dir.clone());
    },
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
    onToggleSection: () => {
      const open = !sectionCtl.el.isShown();
      sectionCtl.setOpen(open);
      return open;
    },
    onToggleExplode: () => {
      const open = !explodeCtl.el.isShown();
      explodeCtl.setOpen(open);
      return open;
    },
    onScreenshot: () => void takeScreenshot(host, controller, labelLayer, opts),
  });

  // Per-frame overlays: keep the cube oriented and the labels positioned.
  controller.registerFrameCallback(() => cube.update());
  controller.registerFrameCallback(() =>
    labelLayer.update(controller.getCamera(), controller.getDomElement()),
  );
  controller.registerDisposable(cube);
  controller.registerDisposable(annotations);
  controller.registerDisposable(measurements);
  controller.registerDisposable(labelLayer);

  // Apply an embed's requested initial framing.
  if (opts.initialView && VIEW_DIRS[opts.initialView]) {
    controller.setViewDirection(VIEW_DIRS[opts.initialView].clone());
  }
  if (opts.initialRoll) controller.rollInstant(opts.initialRoll);

  return {
    controller,
    dispose: () => {
      controller.dispose();
      host.empty();
    },
  };
}

/**
 * Capture the current view as a PNG (WebGL buffer + projected label captions),
 * save it next to the model, and copy an embed link to the clipboard.
 */
async function takeScreenshot(
  host: HTMLElement,
  controller: ViewerController,
  labelLayer: LabelLayer,
  opts: MountOptions,
): Promise<void> {
  try {
    const dom = controller.getDomElement();
    const cssW = dom.clientWidth || dom.width;
    const cssH = dom.clientHeight || dom.height;
    const scale = cssW ? dom.width / cssW : 1;
    const url = controller.captureImage();

    const canvas = activeDocument.createElement("canvas");
    canvas.width = dom.width;
    canvas.height = dom.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");

    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("image decode failed"));
      img.src = url;
    });
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    labelLayer.drawOnto(ctx, controller.getCamera(), cssW, cssH, scale);

    const base64 = canvas.toDataURL("image/png").split(",")[1];
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

    const app = opts.plugin.app;
    const slash = opts.filePath.lastIndexOf("/");
    const folder = slash >= 0 ? opts.filePath.slice(0, slash) : "";
    const base = opts.filePath.slice(slash + 1).replace(/\.[^.]+$/, "");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const outPath = `${folder ? folder + "/" : ""}${base}-view-${stamp}.png`;

    await app.vault.createBinary(outPath, bytes.buffer);
    try {
      await navigator.clipboard.writeText(`![[${outPath}]]`);
      new Notice(`Saved ${outPath}\nEmbed link copied to clipboard.`);
    } catch {
      new Notice(`Saved ${outPath}`);
    }
  } catch (err) {
    console.error("[STEP Viewer] Screenshot failed", err);
    new Notice("Screenshot failed — see console.");
  }
}
