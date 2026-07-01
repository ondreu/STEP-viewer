import { MarkdownRenderChild, Plugin, TFile } from "obsidian";
import { OcctLoader } from "../viewer/OcctLoader";
import { DEFAULT_PARAMS } from "../viewer/params";
import { mountViewer, ViewerHandle } from "../viewer/mountViewer";

const DEFAULT_HEIGHT = 400;

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
 *   ```
 * `path` may be a wikilink target or a vault-relative path. A bare first line is
 * also accepted as the path.
 */
export class StepEmbed extends MarkdownRenderChild {
  private observer: IntersectionObserver | null = null;
  private viewer: ViewerHandle | null = null;
  private host!: HTMLElement;
  private linktext = "";
  private wantMounted = false;
  private busy = false;

  constructor(
    containerEl: HTMLElement,
    private plugin: Plugin,
    private source: string,
    private sourcePath: string,
  ) {
    super(containerEl);
  }

  onload(): void {
    const { path, height } = parseSource(this.source);
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

      this.host.empty();
      const loading = this.host.createDiv({
        cls: "step-viewer-overlay step-viewer-loading",
      });
      loading.createDiv({ cls: "step-viewer-spinner" });
      loading.createEl("div", { text: "Loading STEP…", cls: "step-viewer-message" });

      const buffer = await this.plugin.app.vault.readBinary(file);
      const occt = await OcctLoader.get();
      const result = occt.ReadStepFile(new Uint8Array(buffer), DEFAULT_PARAMS);
      if (!result || !result.success) throw new Error("Could not parse STEP file.");

      // Scrolled away (or unloaded) while we were parsing — bail out.
      if (!this.wantMounted) return;

      this.host.empty();
      if (!result.meshes || result.meshes.length === 0) {
        this.message("This file contains no displayable geometry.");
        return;
      }
      this.viewer = mountViewer(this.host, result, {
        plugin: this.plugin,
        filePath: file.path,
      });
    } catch (err) {
      console.error("[STEP Viewer] Embed failed", this.linktext, err);
      this.message(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy = false;
    }
  }

  private resolveFile(linktext: string): TFile | null {
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

function parseSource(source: string): { path: string; height: number } {
  let path = "";
  let height = DEFAULT_HEIGHT;
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\w+)\s*:\s*(.+)$/.exec(line);
    if (m) {
      const key = m[1].toLowerCase();
      const value = m[2].trim();
      if (key === "path") path = stripLink(value);
      else if (key === "height") {
        const n = parseInt(value, 10);
        if (!Number.isNaN(n)) height = Math.max(120, n);
      }
    } else if (!path) {
      path = stripLink(line); // a bare line is treated as the path
    }
  }
  return { path, height };
}

/** Accept `[[file.step]]` as well as a plain path. */
function stripLink(v: string): string {
  return v.replace(/^\[\[/, "").replace(/\]\]$/, "").trim();
}
