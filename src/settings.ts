import {
  Profile,
  QualityTier,
  DEFAULT_PROFILE,
  tiersForProfile,
} from "./viewer/params";
import { GeometryCache } from "./viewer/GeometryCache";

/** Persisted plugin settings. */
export interface StepViewerSettings {
  /** Selected performance profile, or "custom" when the tiers were hand-edited. */
  profile: Profile;
  /** Size→coarseness tiers actually used to pick mesh quality (source of truth). */
  tiers: QualityTier[];
  /** Cache parsed geometry so reopening a model is near-instant. */
  cacheEnabled: boolean;
  /** Cache size cap in MB (LRU-evicted). */
  cacheMaxMB: number;
}

export const DEFAULT_SETTINGS: StepViewerSettings = {
  profile: DEFAULT_PROFILE,
  tiers: tiersForProfile(DEFAULT_PROFILE),
  cacheEnabled: true,
  cacheMaxMB: 500,
};

/**
 * A plugin that carries STEP Viewer settings + the shared geometry cache (used
 * by the views/embeds). The property is `stepSettings`, not `settings`: Obsidian
 * 1.13 introduced an official `Plugin.settings`, and reusing that name collides.
 */
export interface HasStepSettings {
  stepSettings: StepViewerSettings;
  geometryCache: GeometryCache;
}
