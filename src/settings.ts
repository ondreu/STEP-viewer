import { Quality, DEFAULT_QUALITY } from "./viewer/params";

/** Persisted plugin settings. */
export interface StepViewerSettings {
  /** Mesh quality used when opening models. See `Quality` in viewer/params. */
  quality: Quality;
}

export const DEFAULT_SETTINGS: StepViewerSettings = {
  quality: DEFAULT_QUALITY,
};

/**
 * A plugin that carries STEP Viewer settings (used by the views/embeds).
 * The property is `stepSettings`, not `settings`: Obsidian 1.13 introduced an
 * official `Plugin.settings`, and reusing that name collides with it.
 */
export interface HasStepSettings {
  stepSettings: StepViewerSettings;
}
