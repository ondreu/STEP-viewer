import { OcctReadParams } from "../types";
import { StepModel } from "./StepToThree";
import { objToStepModel, stlToStepModel } from "./MeshLoaders";
import { fcstdToStepModel } from "./FreeCadLoader";

/** True for formats built straight into a model instead of via the STEP reader. */
export function isDirectFormat(extension: string): boolean {
  return /^(obj|stl|fcstd)$/i.test(extension);
}

/**
 * Build a model from an OBJ, STL or FreeCAD file. These skip the geometry cache:
 * the meshes parse fast, and a FreeCAD document is many OCCT parses, not the
 * single one the cache keys. `params` only affects FreeCAD's BREP shapes.
 */
export async function loadDirectModel(
  extension: string,
  buffer: ArrayBuffer,
  name: string,
  params: OcctReadParams,
): Promise<StepModel> {
  switch (extension.toLowerCase()) {
    case "obj":
      return objToStepModel(new TextDecoder().decode(buffer), name);
    case "stl":
      return stlToStepModel(buffer, name);
    default:
      return fcstdToStepModel(new Uint8Array(buffer), name, params);
  }
}
