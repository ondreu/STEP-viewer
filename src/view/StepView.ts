import { FileView, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { OcctLoader } from "../viewer/OcctLoader";
import { DEFAULT_PARAMS } from "../viewer/params";
import { stepToThree } from "../viewer/StepToThree";
import { ViewerController } from "../viewer/ViewerController";
import { createToolbar } from "../ui/Toolbar";

export const STEP_VIEW_TYPE = "step-viewer-view";

/**
 * Read-only, file-driven view for STEP models (design doc §5.2).
 *
 * We extend FileView (not TextFileView): STEP is ASCII, but we never edit it or
 * hold it as a string — we read it binary and hand it to the parser.
 *
 * The ViewerController is created in `onLoadFile` and disposed in
 * `onUnloadFile`/`onClose`, because a single leaf may load several files over
 * its lifetime (design doc §5.2 note).
 */
export class StepView extends FileView {
  private controller: ViewerController | null = null;
  private loadToken = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: Plugin,
  ) {
    super(leaf);
    this.navigation = true;
  }

  getViewType(): string {
    return STEP_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.file?.basename ?? "STEP model";
  }

  getIcon(): string {
    return "box";
  }

  async onLoadFile(file: TFile): Promise<void> {
    // Guard against overlapping loads when the file switches rapidly.
    const token = ++this.loadToken;

    this.teardownController();
    const container = this.contentEl;
    container.empty();
    container.addClass("step-viewer-content");

    const host = container.createDiv({ cls: "step-viewer-host" });
    const loadingEl = this.showLoading(host);

    try {
      const buffer = await this.app.vault.readBinary(file);
      if (token !== this.loadToken) return; // superseded by a newer load

      const bytes = new Uint8Array(buffer);
      const occt = await OcctLoader.get(this.plugin); // lazy WASM init
      if (token !== this.loadToken) return;

      const result = occt.ReadStepFile(bytes, DEFAULT_PARAMS);
      if (!result || !result.success) {
        throw new Error("Could not parse this STEP file (occt success=false).");
      }

      if (token !== this.loadToken) return;

      if (!result.meshes || result.meshes.length === 0) {
        loadingEl.remove();
        this.showEmpty(host);
        return;
      }

      const group = stepToThree(result);
      loadingEl.remove();

      this.controller = new ViewerController(host);
      this.controller.setModel(group);
      createToolbar(host, this.controller);
    } catch (err) {
      if (token !== this.loadToken) return;
      loadingEl.remove();
      this.showError(host, file, err);
    }
  }

  async onUnloadFile(): Promise<void> {
    this.loadToken++;
    this.teardownController();
  }

  async onClose(): Promise<void> {
    this.loadToken++;
    this.teardownController();
  }

  private teardownController(): void {
    this.controller?.dispose();
    this.controller = null;
  }

  private showLoading(host: HTMLElement): HTMLElement {
    const el = host.createDiv({ cls: "step-viewer-overlay step-viewer-loading" });
    el.createDiv({ cls: "step-viewer-spinner" });
    el.createEl("div", { text: "Loading STEP…", cls: "step-viewer-message" });
    return el;
  }

  private showEmpty(host: HTMLElement): void {
    const el = host.createDiv({ cls: "step-viewer-overlay step-viewer-empty" });
    el.createEl("div", {
      text: "This file contains no displayable geometry.",
      cls: "step-viewer-message",
    });
  }

  private showError(host: HTMLElement, file: TFile, err: unknown): void {
    // Log full detail to the console; show the user a clean message (design §8).
    console.error("[STEP Viewer] Failed to open", file.path, err);
    const el = host.createDiv({ cls: "step-viewer-overlay step-viewer-error" });
    el.createEl("div", {
      text: `Could not open "${file.name}".`,
      cls: "step-viewer-message",
    });
    const detail = err instanceof Error ? err.message : String(err);
    el.createEl("div", { text: detail, cls: "step-viewer-message-sub" });
  }
}
