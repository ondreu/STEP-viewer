import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import { STEP_VIEW_TYPE, StepView } from "./view/StepView";
import { StepEmbed } from "./embed/StepEmbed";
import { StepViewerSettings, DEFAULT_SETTINGS } from "./settings";
import { Quality } from "./viewer/params";

/**
 * STEP Viewer plugin entry point (design doc §5.1).
 *
 * `registerView` binds the view type to a factory; `registerExtensions` routes
 * `.step`/`.stp` files to that view type. A `step` code-block processor renders
 * inline note embeds. Everything registered via `this.*` is torn down
 * automatically on `onunload`. The WASM parser is initialised lazily on first
 * file open, not here.
 */
export default class StepViewerPlugin extends Plugin {
  settings: StepViewerSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(STEP_VIEW_TYPE, (leaf) => new StepView(leaf, this));
    this.registerExtensions(["step", "stp"], STEP_VIEW_TYPE);

    this.registerMarkdownCodeBlockProcessor("step", (source, el, ctx) => {
      ctx.addChild(new StepEmbed(el, this, source, ctx.sourcePath));
    });

    this.addSettingTab(new StepViewerSettingTab(this.app, this));
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // onunload: Obsidian de-registers views/extensions registered via this.register*
}

const QUALITY_OPTIONS: Record<Quality, string> = {
  auto: "Auto (coarser for large files)",
  high: "High (finest, small files)",
  balanced: "Balanced",
  low: "Low (coarsest, huge files)",
};

class StepViewerSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: StepViewerPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Mesh quality")
      .setDesc(
        "Detail of the generated 3D mesh. Large models can exceed the parser's " +
          "memory at the finest setting; “Auto” coarsens the mesh as files grow " +
          "so big models still open. Reopen a model for changes to take effect.",
      )
      .addDropdown((dd) => {
        for (const [value, label] of Object.entries(QUALITY_OPTIONS)) {
          dd.addOption(value, label);
        }
        dd.setValue(this.plugin.settings.quality).onChange(async (value) => {
          this.plugin.settings.quality = value as Quality;
          await this.plugin.saveSettings();
        });
      });
  }
}
