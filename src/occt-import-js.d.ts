// Ambient type declarations for occt-import-js (ships no bundled .d.ts;
// design doc §11.2) and the shape of ReadStepFile results (design doc §6.3).
//
// This is a standalone ambient declaration file with no top-level imports, so
// `declare module` here *defines* the module rather than augmenting it.

declare module "occt-import-js" {
  /** Parameters passed to `ReadStepFile`. See design doc §6.2. */
  export interface OcctReadParams {
    linearUnit?: "millimeter" | "centimeter" | "meter" | "inch" | "foot";
    linearDeflectionType?: "bounding_box_ratio" | "absolute_value";
    linearDeflection?: number;
    angularDeflection?: number;
  }

  /**
   * A flat numeric buffer. occt-import-js returns plain `number[]`, but when the
   * parse runs in a Web Worker the arrays are converted to typed arrays before
   * being transferred back (design: large-file support). Both are consumed by
   * StepToThree, so the type admits either.
   */
  export type OcctNumberArray = number[] | Float32Array | Uint16Array | Uint32Array;

  export interface OcctBufferAttribute {
    array: OcctNumberArray;
  }

  export interface OcctBrepFace {
    first: number; // index of the first triangle in this face segment
    last: number; // index of the last triangle in this face segment
    color: [number, number, number] | null; // 0..1 RGB, may be null
  }

  export interface OcctMesh {
    name: string;
    color?: [number, number, number]; // 0..1 RGB, may be absent
    attributes: {
      position: OcctBufferAttribute; // xyz flat
      normal?: OcctBufferAttribute; // xyz flat, may be absent
    };
    index: OcctBufferAttribute; // triangle indices
    brep_faces?: OcctBrepFace[]; // per-face colors/segments
  }

  export interface OcctNode {
    name: string;
    meshes: number[]; // indices into OcctResult.meshes
    children: OcctNode[];
  }

  export interface OcctResult {
    success: boolean;
    root: OcctNode;
    meshes: OcctMesh[];
  }

  /**
   * Emscripten module factory. Accepts standard emscripten overrides such as
   * `wasmBinary` (raw .wasm bytes) so we do not depend on `locateFile`/fetch,
   * which is unreliable inside Obsidian (design doc §6.1).
   */
  export interface OcctModuleOverrides {
    wasmBinary?: ArrayBuffer | Uint8Array;
    locateFile?: (path: string, prefix: string) => string;
    [key: string]: unknown;
  }

  export interface OcctModule {
    ReadStepFile(content: Uint8Array, params: OcctReadParams | null): OcctResult;
    ReadBrepFile?(content: Uint8Array, params: OcctReadParams | null): OcctResult;
    ReadIgesFile?(content: Uint8Array, params: OcctReadParams | null): OcctResult;
  }

  const factory: (overrides?: OcctModuleOverrides) => Promise<OcctModule>;
  export default factory;
}

// The wasm-gzip esbuild plugin turns `import x from "….wasm"` into a gzipped,
// base64-encoded string (inflated at runtime in OcctLoader).
declare module "*.wasm" {
  const data: string;
  export default data;
}

// The inline-worker esbuild plugin bundles `import code from "./x?worker"` into
// the worker's full IIFE source as a string, which OcctLoader turns into a
// Blob-URL Worker (keeps the plugin self-contained; no separate worker file).
declare module "*?worker" {
  const code: string;
  export default code;
}
