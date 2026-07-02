import { OcctReadParams } from "../types";

/**
 * Mesh quality is driven by file size: bigger files get a coarser
 * `linearDeflection` so the viewer stays fast and light (the stated priority —
 * detailed inspection belongs in dedicated CAD tools). `linearDeflection` is a
 * bounding-box ratio, so the same value gives comparable density regardless of
 * model scale; a coarser value means far fewer triangles → faster OCCT
 * tessellation, transfer, and three.js build.
 */

/**
 * One size→coarseness step: files up to `maxMB` use `deflection`. `maxMB: null`
 * is the catch-all for anything larger (kept as null, not Infinity, so it
 * survives JSON round-tripping through Obsidian's data.json).
 */
export interface QualityTier {
  maxMB: number | null;
  deflection: number;
}

/** Named performance profiles; `custom` means the user edited the tiers. */
export type Profile = "fastest" | "balanced" | "detailed" | "custom";

/**
 * Tier presets. Sorted ascending by `maxMB`; the last entry (`maxMB: null`) is
 * the catch-all for anything larger. "fastest" is the default — speed first,
 * quality second.
 */
export const TIER_PRESETS: Record<Exclude<Profile, "custom">, QualityTier[]> = {
  fastest: [
    { maxMB: 10, deflection: 0.005 },
    { maxMB: 40, deflection: 0.02 },
    { maxMB: 80, deflection: 0.05 },
    { maxMB: null, deflection: 0.1 },
  ],
  balanced: [
    { maxMB: 20, deflection: 0.002 },
    { maxMB: 50, deflection: 0.008 },
    { maxMB: 80, deflection: 0.02 },
    { maxMB: null, deflection: 0.04 },
  ],
  detailed: [
    { maxMB: 20, deflection: 0.001 },
    { maxMB: 50, deflection: 0.003 },
    { maxMB: 80, deflection: 0.008 },
    { maxMB: null, deflection: 0.02 },
  ],
};

export const DEFAULT_PROFILE = "fastest" as const;

/** A fresh copy of a preset's tiers (so callers can mutate without aliasing). */
export function tiersForProfile(profile: Exclude<Profile, "custom">): QualityTier[] {
  return TIER_PRESETS[profile].map((t) => ({ ...t }));
}

const MB = 1024 * 1024;

/** Pick the coarseness for a file: first tier whose `maxMB` fits, else the last. */
export function deflectionForSize(sizeBytes: number, tiers: QualityTier[]): number {
  const mb = sizeBytes / MB;
  for (const t of tiers) {
    if (t.maxMB == null || mb <= t.maxMB) return t.deflection;
  }
  const last = tiers[tiers.length - 1];
  return last ? last.deflection : 0.02;
}

/**
 * Build `ReadStepFile` params from a chosen linear deflection. Coarser meshes
 * also get a coarser `angularDeflection` (radians) so curved faces shed facets
 * too — another big speed win on holes/cylinders.
 */
export function paramsForDeflection(linearDeflection: number): OcctReadParams {
  const angularDeflection =
    linearDeflection >= 0.02 ? 1.0 : linearDeflection >= 0.005 ? 0.8 : 0.5;
  return {
    linearUnit: "millimeter",
    linearDeflectionType: "bounding_box_ratio",
    linearDeflection,
    angularDeflection,
  };
}

/** Coarsen a deflection for a "try faster" retry (always coarser, capped). */
export function coarserDeflection(deflection: number): number {
  return Math.min(0.2, deflection * 3);
}
