// Re-export the occt-import-js result/param types (declared ambiently in
// src/occt-import-js.d.ts) so the rest of the codebase can import them from a
// single stable path.

export type {
  OcctReadParams,
  OcctBufferAttribute,
  OcctBrepFace,
  OcctMesh,
  OcctNode,
  OcctResult,
  OcctModule,
  OcctModuleOverrides,
} from "occt-import-js";
