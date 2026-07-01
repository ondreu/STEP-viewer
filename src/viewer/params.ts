import { OcctReadParams } from "../types";

/**
 * Default tessellation parameters for `ReadStepFile` (design doc §6.2).
 *
 * `linearDeflectionType: "bounding_box_ratio"` means `linearDeflection` is
 * interpreted relative to the model bounding box, so the same value gives a
 * reasonable mesh density regardless of model scale. Smaller deflection = finer
 * mesh = more triangles. Values marked `[OVĚŘIT]` in the doc were kept as the
 * documented defaults.
 */
export const DEFAULT_PARAMS: OcctReadParams = {
  linearUnit: "millimeter",
  linearDeflectionType: "bounding_box_ratio",
  linearDeflection: 0.001,
  angularDeflection: 0.5,
};
