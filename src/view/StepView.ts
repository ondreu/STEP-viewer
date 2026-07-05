import { FileView, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { OcctLoader } from "../viewer/OcctLoader";
import {
  deflectionForSize,
  paramsForDeflection,
  coarserDeflection,
} from "../viewer/params";
import { cacheKey, resultBytes, CACHE_MIN_BYTES } from "../viewer/GeometryCache";
import { mountViewer, mountModel, ViewerHandle } from "../viewer/mountViewer";
import { objToStepModel, stlToStepModel } from "../viewer/MeshLoaders";
import { fcstdToStepModel } from "../viewer/FreeCadLoader";
import { formatFileSize, shouldWarnLargeModel } from "../viewer/mobileGuard";
import { hasRenderableMeshes, isWireframeOnly } from "../viewer/StepToThree";
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
    deflectionOverride?: number,
  ): Promise<void> {
    const loadingEl = this.showLoading(host);
    const settings = this.plugin.stepSettings;
    const deflection =
      deflectionOverride ?? deflectionForSize(file.stat.size, settings.tiers);
    const useCache =
      settings.cacheEnabled && file.stat.size >= CACHE_MIN_BYTES;
    const key = cacheKey(file.path, file.stat.mtime, file.stat.size, deflection);

    try {
      // Plain triangle-mesh formats (OBJ/STL) are parsed directly in the
      // renderer — no OCCT, no cache. Useful on their own and as an escape
      // hatch for STEP files with malformed faces (heal + re-export as OBJ).
      const ext = file.extension.toLowerCase();
      if (ext === "obj" || ext === "stl") {
        const buffer = await this.app.vault.readBinary(file);
        if (token !== this.loadToken) return;
        const model =
          ext === "obj"
            ? objToStepModel(new TextDecoder().decode(buffer), file.basename)
            : stlToStepModel(buffer, file.basename);
        loadingEl.remove();
        this.viewer = mountModel(host, model, {
          plugin: this.plugin,
          filePath: file.path,
          healFaces: settings.healFaces,
        });
        return;
      }

      // FreeCAD documents (.FCStd): a ZIP of native BREP shapes. Unzip and parse
      // each visible object's BREP through OCCT (see FreeCadLoader). Not cached —
      // the geometry cache keys a single OCCT parse, not this multi-shape build.
      if (ext === "fcstd") {
        const buffer = await this.app.vault.readBinary(file);
        if (token !== this.loadToken) return;
        const model = await fcstdToStepModel(
          new Uint8Array(buffer),
          file.basename,
          paramsForDeflection(deflection),
        );
        if (token !== this.loadToken) return;
        loadingEl.remove();
        this.viewer = mountModel(host, model, {
          plugin: this.plugin,
          filePath: file.path,
          healFaces: settings.healFaces,
        });
        return;
      }

      // Fast path: reload previously parsed geometry, skipping OCCT entirely.
      if (useCache) {
        const cached = await this.plugin.geometryCache.get(key);
        if (token !== this.loadToken) return;
        if (cached && hasRenderableMeshes(cached)) {
          console.info("[STEP Viewer] cache hit", file.path);
          loadingEl.remove();
          this.viewer = mountViewer(host, cached, {
            plugin: this.plugin,
            filePath: file.path,
            healFaces: settings.healFaces,
          });
          return;
        }
      }

      const buffer = await this.app.vault.readBinary(file);
      if (token !== this.loadToken) return; // superseded by a newer load

      const bytes = new Uint8Array(buffer);
      // Decode text for metadata *before* parsing: the worker parse transfers
      // (neutralises) the byte buffer, and large files skip decoding entirely.
      const stepText = decodeStep(bytes);

      const { result, logs } = await OcctLoader.parseStep(
        bytes,
        paramsForDeflection(deflection),
      );
      if (token !== this.loadToken) return;

      if (!hasRenderableMeshes(result)) {
        loadingEl.remove();
        this.showNoGeometry(host, file, token, deflection, logs, stepText);
        return;
      }

      if (useCache) {
        const cache = this.plugin.geometryCache;
        const maxBytes = settings.cacheMaxMB * 1024 * 1024;
        void cache
          .put(key, result, resultBytes(result))
          .then(() => cache.enforceCap(maxBytes));
      }

      loadingEl.remove();
      this.viewer = mountViewer(host, result, {
        plugin: this.plugin,
        filePath: file.path,
        stepText,
        healFaces: settings.healFaces,
      });
    } catch (err) {
      if (token !== this.loadToken) return;
      loadingEl.remove();
      this.showError(host, file, err, token, deflection);
    }
  }

  /** Re-parse coarser (faster/lighter), e.g. after an out-of-memory failure. */
  private retryFaster(
    file: TFile,
    host: HTMLElement,
    token: number,
    deflection: number,
  ): void {
    if (token !== this.loadToken) return;
    host.empty();
    void this.parseAndMount(file, host, token, coarserDeflection(deflection));
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
    deflection: number,
    logs: string[] = [],
    stepText?: string,
  ): void {
    const el = host.createDiv({ cls: "step-viewer-overlay step-viewer-error" });
    // A wireframe-only file has nothing to tessellate: no retry or coarser mesh
    // will ever help, so treat it as its own case with a precise explanation.
    const wireframe = isWireframeOnly(stepText);
    el.createEl("div", {
      text: wireframe ? "No surfaces or solids to display" : "No geometry could be displayed",
      cls: "step-viewer-message",
    });
    // If OCCT's output hints at an allocation failure, say so plainly — that's
    // the memory ceiling, not an unsupported file.
    const outOfMemory = logs.some((l) => /memory|alloc|bad_alloc|out of/i.test(l));
    const canRetry = !wireframe && coarserDeflection(deflection) > deflection;
    let detail: string;
    if (wireframe) {
      detail =
        `This file contains only wireframe curves (edges / sketch geometry) — ` +
        "no surface or solid bodies — so there is nothing to render as a 3D model. " +
        "Re-export it from your CAD program with solid or surface geometry included " +
        "(in SolidWorks: File → Save As → STEP, and make sure solid/surface bodies " +
        "are exported, not just curves).";
    } else if (outOfMemory) {
      detail =
        `This ${formatFileSize(file.stat.size)} model ran the in-browser (WASM) parser ` +
        "out of memory before it could produce geometry.";
    } else {
      detail =
        `The parser produced no usable geometry from this ${formatFileSize(file.stat.size)} ` +
        "file. It may be too large for the in-browser (WASM) parser, or it uses " +
        "entities the parser doesn't support.";
    }
    el.createEl("div", {
      text: detail + (canRetry ? " Retrying coarser (faster) may help." : ""),
      cls: "step-viewer-message-sub",
    });
    if (canRetry) this.addRetryButton(el, file, host, token, deflection);
  }

  /** A button that re-parses coarser/faster (memory & speed recovery). */
  private addRetryButton(
    parent: HTMLElement,
    file: TFile,
    host: HTMLElement,
    token: number,
    deflection: number,
  ): void {
    const btn = parent.createEl("button", {
      text: "Try coarser (faster)",
      cls: "mod-cta",
    });
    btn.addEventListener("click", () => this.retryFaster(file, host, token, deflection));
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
    deflection: number,
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
    // coarser/faster retry unless we're already at the coarsest.
    if (coarserDeflection(deflection) > deflection) {
      this.addRetryButton(el, file, host, token, deflection);
    }
  }
}
