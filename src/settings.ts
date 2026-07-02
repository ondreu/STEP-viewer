import {
  Profile,
  QualityTier,
  DEFAULT_PROFILE,
  tiersForProfile,
} from "./viewer/params";

/** Persisted plugin settings. */
export interface StepViewerSettings {
  /** Selected performance profile, or "custom" when the tiers were hand-edited. */
  profile: Profile;
  /** Size→coarseness tiers actually used to pick mesh quality (source of truth). */
  tiers: QualityTier[];
}

export const DEFAULT_SETTINGS: StepViewerSettings = {
  profile: DEFAULT_PROFILE,
  tiers: tiersForProfile(DEFAULT_PROFILE),
};

/**
 * A plugin that carries STEP Viewer settings (used by the views/embeds).
 * The property is `stepSettings`, not `settings`: Obsidian 1.13 introduced an
 * official `Plugin.settings`, and reusing that name collides with it.
 */
export interface HasStepSettings {
  stepSettings: StepViewerSettings;
}
