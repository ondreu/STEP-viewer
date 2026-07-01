import { Plugin } from "obsidian";
import { STEP_VIEW_TYPE, StepView } from "./view/StepView";
import { StepEmbed } from "./embed/StepEmbed";

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
  async onload(): Promise<void> {
    this.registerView(STEP_VIEW_TYPE, (leaf) => new StepView(leaf, this));
    this.registerExtensions(["step", "stp"], STEP_VIEW_TYPE);

    this.registerMarkdownCodeBlockProcessor("step", (source, el, ctx) => {
      ctx.addChild(new StepEmbed(el, this, source, ctx.sourcePath));
    });
  }

  // onunload: Obsidian de-registers views/extensions registered via this.register*
}
