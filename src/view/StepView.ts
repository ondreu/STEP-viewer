import { FileView, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { OcctLoader } from "../viewer/OcctLoader";
import { paramsForFile, Quality } from "../viewer/params";
import { mountViewer, ViewerHandle } from "../viewer/mountViewer";
import { formatFileSize, shouldWarnLargeModel } from "../viewer/mobileGuard";
import { hasRenderableMeshes } from "../viewer/StepToThree";
import { METADATA_MAX_BYTES } from "../viewer/StepMeta";
import { HasStepSettings } from "../settings";

export const STEP_VIEW_TYPE = "step-viewer-view";

/**
 * Decode STEP bytes to text for metadata extraction (STEP is ASCII/Latin-1).
 * Only worthwhile within the metadata budget — a large file would produce a
 * huge string that `parseStepMeta` skips anyway, so we don't decode it.
 */
function decodeStep(bytes: Uint8Array): string | undefined {
  if (bytes.length > METADATA_MAX_BYTES) return undefined;
  return new TextDecoder("latin1").decode(bytes);
}

/**
 * Read-only, file-driven view for STEP models (design doc §5.2).
 *
 * We extend FileView (not TextFileView): STEP is ASCII, but we never edit it or
 * hold it as a string — we read it binary and hand it to the parser.
 *
 * The viewer is created in `onLoadFile` and disposed in `onUnloadFile`/`onClose`,
 * because a single leaf may load several files over its lifetime (design §5.2).
 */
export class StepView extends FileView {
  private viewer: ViewerHandle | null = null;
  private loadToken = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: Plugin & HasStepSettings,
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

    this.teardownViewer();
    const container = this.contentEl;
    container.empty();
    container.addClass("step-viewer-content");

    const host = container.createDiv({ cls: "step-viewer-host" });

    // On mobile, large models risk exhausting the WASM parser's memory, so we
    // confirm before attempting the parse instead of risking a hard failure.
    if (shouldWarnLargeModel(file.stat.size)) {
      this.showLargeWarning(host, file.stat.size, () => {
        if (token !== this.loadToken) return;
        host.empty();
        void this.parseAndMount(file, host, token);
      });
      return;
    }

    await this.parseAndMount(file, host, token);
  }

  private async parseAndMount(
    file: TFile,
    host: HTMLElement,
    token: number,
    qualityOverride?: Quality,
  ): Promise<void> {
    const loadingEl = this.showLoading(host);
    const quality = qualityOverride ?? this.plugin.stepSettings.quality;

    try {
      const buffer = await this.app.vault.readBinary(file);
      if (token !== this.loadToken) return; // superseded by a newer load

      const bytes = new Uint8Array(buffer);
      // Decode text for metadata *before* parsing: the worker parse transfers
      // (neutralises) the byte buffer, and large files skip decoding entirely.
      const stepText = decodeStep(bytes);

      const params = paramsForFile(file.stat.size, quality);
      const result = await OcctLoader.parseStep(bytes, params);
      if (token !== this.loadToken) return;

      if (!hasRenderableMeshes(result)) {
        loadingEl.remove();
        this.showNoGeometry(host, file, token, quality);
        return;
      }

      loadingEl.remove();
      this.viewer = mountViewer(host, result, {
        plugin: this.plugin,
        filePath: file.path,
        stepText,
      });
    } catch (err) {
      if (token !== this.loadToken) return;
      loadingEl.remove();
      this.showError(host, file, err, token, quality);
    }
  }

  /** Re-parse the file at the coarsest quality, e.g. after an out-of-memory failure. */
  private retryLowQuality(file: TFile, host: HTMLElement, token: number): void {
    if (token !== this.loadToken) return;
    host.empty();
    void this.parseAndMount(file, host, token, "low");
  }

  async onUnloadFile(): Promise<void> {
    this.loadToken++;
    this.teardownViewer();
  }

  async onClose(): Promise<void> {
    this.loadToken++;
    this.teardownViewer();
  }

  private teardownViewer(): void {
    this.viewer?.dispose();
    this.viewer = null;
  }

  private showLoading(host: HTMLElement): HTMLElement {
    const el = host.createDiv({ cls: "step-viewer-overlay step-viewer-loading" });
    el.createDiv({ cls: "step-viewer-spinner" });
    el.createEl("div", { text: "Loading STEP…", cls: "step-viewer-message" });
    return el;
  }

  private showNoGeometry(
    host: HTMLElement,
    file: TFile,
    token: number,
    quality: Quality,
  ): void {
    const el = host.createDiv({ cls: "step-viewer-overlay step-viewer-error" });
    el.createEl("div", {
      text: "No geometry could be displayed",
      cls: "step-viewer-message",
    });
    const canRetry = quality !== "low";
    el.createEl("div", {
      text:
        `The parser produced no usable geometry from this ${formatFileSize(file.stat.size)} ` +
        "file. It may be too large for the in-browser (WASM) parser, or it uses " +
        "entities the parser doesn't support." +
        (canRetry ? " Retrying at a lower quality may fit it in memory." : ""),
      cls: "step-viewer-message-sub",
    });
    if (canRetry) this.addRetryButton(el, file, host, token);
  }

  /** A button that re-parses at the coarsest quality (memory recovery). */
  private addRetryButton(
    parent: HTMLElement,
    file: TFile,
    host: HTMLElement,
    token: number,
  ): void {
    const btn = parent.createEl("button", {
      text: "Try lower quality",
      cls: "mod-cta",
    });
    btn.addEventListener("click", () => this.retryLowQuality(file, host, token));
  }

  private showLargeWarning(
    host: HTMLElement,
    sizeBytes: number,
    onProceed: () => void,
  ): void {
    const el = host.createDiv({ cls: "step-viewer-overlay step-viewer-empty" });
    el.createEl("div", { text: "Large model", cls: "step-viewer-message" });
    el.createEl("div", {
      text: `This file is ${formatFileSize(sizeBytes)}. On mobile, opening large models can run the viewer out of memory. Open anyway?`,
      cls: "step-viewer-message-sub",
    });
    const btn = el.createEl("button", { text: "Open anyway", cls: "mod-cta" });
    btn.addEventListener("click", onProceed);
  }

  private showError(
    host: HTMLElement,
    file: TFile,
    err: unknown,
    token: number,
    quality: Quality,
  ): void {
    // Log full detail to the console; show the user a clean message (design §8).
    console.error("[STEP Viewer] Failed to open", file.path, err);
    const el = host.createDiv({ cls: "step-viewer-overlay step-viewer-error" });
    el.createEl("div", {
      text: `Could not open "${file.name}".`,
      cls: "step-viewer-message",
    });
    const detail = err instanceof Error ? err.message : String(err);
    el.createEl("div", { text: detail, cls: "step-viewer-message-sub" });
    // A parse failure on a large model is often memory exhaustion — offer a
    // coarser retry unless we're already at the lowest quality.
    if (quality !== "low") this.addRetryButton(el, file, host, token);
  }
}
