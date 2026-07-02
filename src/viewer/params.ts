import { OcctReadParams } from "../types";

/**
 * Tessellation quality for `ReadStepFile`.
 *
 * The occt-import-js WASM heap is capped at 2 GB (baked into the module, cannot
 * be raised at runtime). A fine `linearDeflection` produces many triangles,
 * which drives both the WASM tessellation memory and the JS-side geometry
 * buffers — so on large files the fine default can exceed the cap and the parse
 * comes back empty. Coarsening the mesh for large files is the main lever that
 * keeps a ~100 MB model under the cap without recompiling the parser.
 *
 * - `high`     — always the finest mesh (former default); best for small files.
 * - `balanced` — a moderate mesh regardless of size.
 * - `low`      — a coarse mesh regardless of size; last resort for huge files.
 * - `auto`     — pick a deflection from the file size (see `paramsForFile`).
 */
export type Quality = "auto" | "high" | "balanced" | "low";

export const DEFAULT_QUALITY: Quality = "auto";

/** `linearDeflection` per fixed quality tier (bounding-box ratio). */
const FIXED_DEFLECTION: Record<Exclude<Quality, "auto">, number> = {
  high: 0.001,
  balanced: 0.003,
  low: 0.008,
};

const MB = 1024 * 1024;

/**
 * `auto` tiers: coarsen the mesh as the file grows so large models stay under
 * the 2 GB WASM cap. `linearDeflection` is a bounding-box ratio, so the same
 * value gives comparable density regardless of model scale.
 */
function autoDeflection(sizeBytes: number): number {
  if (sizeBytes < 20 * MB) return 0.001;
  if (sizeBytes < 50 * MB) return 0.002;
  if (sizeBytes < 80 * MB) return 0.004;
  return 0.008;
}

/**
 * Tessellation parameters for a file of the given size and quality setting.
 *
 * Larger models also get a coarser `angularDeflection` to further cut triangle
 * count on curved surfaces (design doc §6.2).
 */
export function paramsForFile(sizeBytes: number, quality: Quality): OcctReadParams {
  const linearDeflection =
    quality === "auto" ? autoDeflection(sizeBytes) : FIXED_DEFLECTION[quality];

  // Coarsen angular deflection for large models (more so when we're already
  // coarsening linearly), still fine for small ones.
  const angularDeflection =
    quality === "low" || (quality === "auto" && sizeBytes >= 50 * MB) ? 0.8 : 0.5;

  return {
    linearUnit: "millimeter",
    linearDeflectionType: "bounding_box_ratio",
    linearDeflection,
    angularDeflection,
  };
}
