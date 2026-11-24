import { App, Component, MarkdownRenderChild, Plugin, TFile } from "obsidian";
import { OcctLoader } from "../viewer/OcctLoader";
import {
  Profile,
  deflectionForSize,
  paramsForDeflection,
  tiersForProfile,
} from "../viewer/params";
import { mountModel, mountViewer, ViewerHandle } from "../viewer/mountViewer";
import { isDirectFormat, loadDirectModel } from "../viewer/loadModel";
import { formatFileSize, shouldWarnLargeModel } from "../viewer/mobileGuard";
import { hasRenderableMeshes, isWireframeOnly } from "../viewer/StepToThree";
import { METADATA_MAX_BYTES } from "../viewer/StepMeta";
import { cacheKey, resultBytes, CACHE_MIN_BYTES } from "../viewer/GeometryCache";
import { HasStepSettings } from "../settings";

const EMBED_PROFILES = new Set<Profile>(["fastest", "balanced", "detailed"]);

const DEFAULT_HEIGHT = 400;
const MIN_HEIGHT = 120;

/**
 * Renders a ```step code block as an inline 3D viewer inside a note.
 *
 * Because each viewer holds a WebGL context and those are scarce (design §2.6),
 * the viewer is mounted lazily when the block scrolls into view and disposed
 * when it scrolls away, so a note with many embeds never exhausts contexts.
 *
 * Block syntax:
 *   ```step
 *   path: Models/bracket.step
 *   height: 320
 *   view: front          # front/back/left/right/top/bottom/iso
 *   rotate: 90           # initial roll in degrees (or `roll: 1` in quarter turns)
 *   annotations: false   # hide saved notes in this embed (default true)
 *   quality: detailed    # fastest/balanced/detailed, or a coarseness like 0.01
 *   ```
 * `path` may be a wikilink target or a vault-relative path. A bare first line is
 * also accepted as the path.
 */
export class StepEmbed extends MarkdownRenderChild {
  private observer: IntersectionObserver | null = null;
  private viewer: ViewerHandle | null = null;
  protected host!: HTMLElement;
  private linktext = "";
  private wantMounted = false;
  private busy = false;
  /** Set when the user opts past the mobile large-model warning. */
  private forceLarge = false;

  constructor(
    containerEl: HTMLElement,
    private plugin: Plugin & HasStepSettings,
    private source: string,
    private sourcePath: string,
  ) {
    super(containerEl);
  }

  private opts: ParsedSource = { path: "", height: DEFAULT_HEIGHT };

  onload(): void {
    this.opts = parseSource(this.source);
    const { path, height } = this.opts;
    this.containerEl.empty();
    this.containerEl.addClass("step-viewer-embed");
    this.host = this.containerEl.createDiv({ cls: "step-viewer-embed-host" });
    this.host.style.height = `${height}px`;

    if (!path) {
      this.message("No STEP path. Use a `path:` line inside the ```step block.");
      return;
    }
    this.linktext = path;
    this.placeholder();

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) this.mount();
          else this.unmount();
        }
      },
      { rootMargin: "200px" },
    );
    this.observer.observe(this.host);
  }

  private mount(): void {
    this.wantMounted = true;
    void this.ensure();
  }

  private unmount(): void {
    this.wantMounted = false;
    if (this.viewer) {
      this.viewer.dispose();
      this.viewer = null;
      this.placeholder();
    }
  }

  private async ensure(): Promise<void> {
    if (this.viewer || this.busy) return;
    this.busy = true;
    try {
      const file = this.resolveFile(this.linktext);
      if (!file) throw new Error(`STEP file not found: ${this.linktext}`);

      // On mobile, warn before parsing a large model (memory) unless opted in.
      if (!this.forceLarge && shouldWarnLargeModel(file.stat.size)) {
        this.largeWarning(file.stat.size);
        return;
      }

      this.host.empty();
      const loading = this.host.createDiv({
        cls: "step-viewer-overlay step-viewer-loading",
      });
      loading.createDiv({ cls: "step-viewer-spinner" });
      loading.createEl("div", { text: "Loading STEP…", cls: "step-viewer-message" });

      const settings = this.plugin.stepSettings;
      const deflection = this.deflectionFor(file.stat.size);

      if (isDirectFormat(file.extension)) {
        const model = await loadDirectModel(
          file.extension,
          await this.plugin.app.vault.readBinary(file),
          file.basename,
          paramsForDeflection(deflection),
        );
        if (!this.wantMounted) return;
        this.host.empty();
        this.viewer = mountModel(this.host, model, {
          plugin: this.plugin,
          filePath: file.path,
          showAnnotations: this.opts.showAnnotations,
          initialView: this.opts.view,
          initialRoll: this.opts.roll,
          healFaces: settings.healFaces,
        });
        return;
      }

      const useCache = settings.cacheEnabled && file.stat.size >= CACHE_MIN_BYTES;
      const key = cacheKey(file.path, file.stat.mtime, file.stat.size, deflection);

      // Fast path: reuse previously parsed geometry (skips OCCT).
      if (useCache) {
        const cached = await this.plugin.geometryCache.get(key);
        if (!this.wantMounted) return;
        if (cached && hasRenderableMeshes(cached)) {
          this.host.empty();
          this.viewer = mountViewer(this.host, cached, {
            plugin: this.plugin,
            filePath: file.path,
            showAnnotations: this.opts.showAnnotations,
            initialView: this.opts.view,
            initialRoll: this.opts.roll,
            healFaces: settings.healFaces,
          });
          return;
        }
      }

      const buffer = await this.plugin.app.vault.readBinary(file);
      const bytes = new Uint8Array(buffer);
      // Decode text for metadata before parsing (the worker transfers the byte
      // buffer); skip decoding large files, whose metadata is skipped anyway.
      const stepText =
        bytes.length > METADATA_MAX_BYTES
          ? undefined
          : new TextDecoder("latin1").decode(bytes);

      const { result } = await OcctLoader.parseStep(
        bytes,
        paramsForDeflection(deflection),
      );

      // Scrolled away (or unloaded) while we were parsing — bail out.
      if (!this.wantMounted) return;

      this.host.empty();
      if (!hasRenderableMeshes(result)) {
        this.message(
          isWireframeOnly(stepText)
            ? "This file contains only wireframe curves (no surface or solid bodies), " +
                "so there is nothing to render. Re-export it with solid/surface geometry."
            : `No usable geometry (${formatFileSize(file.stat.size)}). The model may be too ` +
                "large for the in-browser parser, or use unsupported entities.",
        );
        return;
      }

      if (useCache) {
        const cache = this.plugin.geometryCache;
        const maxBytes = settings.cacheMaxMB * 1024 * 1024;
        void cache
          .put(key, result, resultBytes(result))
          .then(() => cache.enforceCap(maxBytes));
      }

      this.viewer = mountViewer(this.host, result, {
        plugin: this.plugin,
        filePath: file.path,
        showAnnotations: this.opts.showAnnotations,
        initialView: this.opts.view,
        initialRoll: this.opts.roll,
        stepText,
        healFaces: settings.healFaces,
      });
    } catch (err) {
      console.error("[STEP Viewer] Embed failed", this.linktext, err);
      this.message(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy = false;
    }
  }

  /**
   * Resolve the mesh coarseness for this embed: an explicit `quality:` override
   * (a profile name or a raw deflection number) wins, otherwise the global
   * size-based tiers apply.
   */
  private deflectionFor(sizeBytes: number): number {
    const q = this.opts.quality;
    if (typeof q === "number") return q;
    if (q) return deflectionForSize(sizeBytes, tiersForProfile(q));
    return deflectionForSize(sizeBytes, this.plugin.stepSettings.tiers);
  }

  protected resolveFile(linktext: string): TFile | null {
    const dest = this.plugin.app.metadataCache.getFirstLinkpathDest(
      linktext,
      this.sourcePath,
    );
    if (dest instanceof TFile) return dest;
    const byPath = this.plugin.app.vault.getAbstractFileByPath(linktext);
    return byPath instanceof TFile ? byPath : null;
  }

  private placeholder(): void {
    this.host.empty();
    const el = this.host.createDiv({
      cls: "step-viewer-overlay step-viewer-embed-placeholder",
    });
    el.createEl("div", { text: this.linktext, cls: "step-viewer-message" });
    el.createEl("div", {
      text: "STEP preview",
      cls: "step-viewer-message-sub",
    });
  }

  private largeWarning(sizeBytes: number): void {
    this.host.empty();
    const el = this.host.createDiv({
      cls: "step-viewer-overlay step-viewer-empty",
    });
    el.createEl("div", { text: this.linktext, cls: "step-viewer-message" });
    el.createEl("div", {
      text: `${formatFileSize(sizeBytes)} — large models may run out of memory on mobile.`,
      cls: "step-viewer-message-sub",
    });
    const btn = el.createEl("button", { text: "Open anyway", cls: "mod-cta" });
    btn.addEventListener("click", () => {
      this.forceLarge = true;
      void this.ensure();
    });
  }

  private message(text: string): void {
    this.host.empty();
    const el = this.host.createDiv({ cls: "step-viewer-overlay step-viewer-error" });
    el.createEl("div", { text, cls: "step-viewer-message-sub" });
  }

  onunload(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.viewer?.dispose();
    this.viewer = null;
  }
}

/** What Obsidian passes when it renders a `![[file]]` embed (the part used here). */
interface EmbedContext {
  containerEl: HTMLElement;
  sourcePath?: string;
}

/**
 * The registry Obsidian renders `![[file]]` embeds from, keyed by extension. It
 * is not in the public API, so every use of it tolerates it being absent.
 */
interface EmbedRegistry {
  isExtensionRegistered(ext: string): boolean;
  registerExtension(ext: string, create: (ctx: EmbedContext, file: TFile) => Component): void;
  unregisterExtension(ext: string): void;
}

/**
 * `![[model.step]]` in a note: the same embed, for a file Obsidian has already
 * resolved. `![[model.step|600]]` and `|600x300` set its size, as for images.
 */
class StepFileEmbed extends StepEmbed {
  private sizeObserver: MutationObserver | null = null;

  constructor(
    ctx: EmbedContext,
    plugin: Plugin & HasStepSettings,
    private file: TFile,
  ) {
    super(ctx.containerEl, plugin, `path: ${file.path}`, ctx.sourcePath ?? "");
  }

  onload(): void {
    super.onload();
    // Tells live preview that a click here is for the viewer. Without it, every
    // drag to orbit would also move the cursor into the link and reveal it.
    this.host.addClass("interactive-child");
    this.applySize();
    // Live preview sets the size attributes only after the embed has loaded.
    this.sizeObserver = new MutationObserver(() => this.applySize());
    this.sizeObserver.observe(this.containerEl, { attributeFilter: ["width", "height"] });
  }

  onunload(): void {
    this.sizeObserver?.disconnect();
    this.sizeObserver = null;
    super.onunload();
  }

  /** Obsidian calls this after `onload`, which has already set up the embed. */
  loadFile(): void {}

  protected resolveFile(): TFile {
    return this.file;
  }

  /** Use the size from the link, otherwise leave it to the stylesheet. */
  private applySize(): void {
    const px = (name: string, min: number): string => {
      const n = parseInt(this.containerEl.getAttribute(name) ?? "", 10);
      return n > 0 ? `${Math.max(min, n)}px` : "";
    };
    this.containerEl.style.width = px("width", 0);
    this.host.style.height = px("height", MIN_HEIGHT);
  }
}

/** Show `![[model.step]]` as a viewer, except for types another plugin embeds. */
export function registerFileEmbeds(
  plugin: Plugin & HasStepSettings,
  extensions: string[],
): void {
  const registry = (plugin.app as App & { embedRegistry?: EmbedRegistry }).embedRegistry;
  if (!registry) return;
  for (const ext of extensions) {
    if (registry.isExtensionRegistered(ext)) continue;
    registry.registerExtension(ext, (ctx, file) => new StepFileEmbed(ctx, plugin, file));
    plugin.register(() => registry.unregisterExtension(ext));
  }
}

interface ParsedSource {
  path: string;
  height: number;
  showAnnotations?: boolean;
  view?: string;
  roll?: number;
  /** Per-embed override: a profile name or a raw coarseness (deflection). */
  quality?: Exclude<Profile, "custom"> | number;
}

const VIEW_NAMES = new Set(["front", "back", "left", "right", "top", "bottom", "iso"]);

function parseSource(source: string): ParsedSource {
  const out: ParsedSource = { path: "", height: DEFAULT_HEIGHT };
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\w+)\s*:\s*(.+)$/.exec(line);
    if (m) {
      const key = m[1].toLowerCase();
      const value = m[2].trim();
      if (key === "path") {
        out.path = stripLink(value);
      } else if (key === "height") {
        const n = parseInt(value, 10);
        if (!Number.isNaN(n)) out.height = Math.max(MIN_HEIGHT, n);
      } else if (key === "annotations") {
        out.showAnnotations = !/^(false|no|0|off)$/i.test(value);
      } else if (key === "view") {
        const v = value.toLowerCase();
        if (VIEW_NAMES.has(v)) out.view = v;
      } else if (key === "roll") {
        const n = parseInt(value, 10);
        if (!Number.isNaN(n)) out.roll = ((n % 4) + 4) % 4;
      } else if (key === "rotate") {
        const deg = parseInt(value, 10);
        if (!Number.isNaN(deg)) out.roll = ((Math.round(deg / 90) % 4) + 4) % 4;
      } else if (key === "quality") {
        // A profile name (fastest/balanced/detailed) or a raw coarseness number.
        const num = parseFloat(value);
        const prof = value.toLowerCase() as Profile;
        if (isFinite(num) && num > 0 && num <= 1) out.quality = num;
        else if (EMBED_PROFILES.has(prof)) out.quality = prof as Exclude<Profile, "custom">;
      }
    } else if (!out.path) {
      out.path = stripLink(line); // a bare line is treated as the path
    }
  }
  return out;
}

/** Accept `[[file.step]]` as well as a plain path. */
function stripLink(v: string): string {
  return v.replace(/^\[\[/, "").replace(/\]\]$/, "").trim();
}
