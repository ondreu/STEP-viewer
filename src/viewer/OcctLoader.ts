import occtimportjs, { OcctModule } from "occt-import-js";
// The .wasm is inlined into the bundle as a Uint8Array by esbuild's binary
// loader (see esbuild.config.mjs). This keeps the plugin self-contained, which
// is required for BRAT (it only installs main.js/manifest.json/styles.css).
import wasmBinary from "occt-import-js/dist/occt-import-js.wasm";

/**
 * Singleton wrapper around the occt-import-js WASM module.
 *
 * The module is compiled/instantiated *lazily* — only on the first STEP file
 * open, never in the plugin's `onload()` (design doc §2.1). The resulting
 * promise is cached so the multi-MB WASM is compiled at most once per session.
 *
 * The WASM bytes are passed to emscripten via `wasmBinary`, so it never tries
 * to `fetch`/`locateFile` the file — which is unreliable inside Obsidian and
 * differs across desktop/mobile (design doc §6.1, §11.4).
 */
let cached: Promise<OcctModule> | null = null;

export const OcctLoader = {
  get(): Promise<OcctModule> {
    if (!cached) {
      cached = occtimportjs({ wasmBinary }).catch((err) => {
        // Reset cache on failure so a later open can retry a transient error.
        cached = null;
        throw err;
      });
    }
    return cached;
  },

  /** Testing/cleanup helper — drops the cached module. */
  reset(): void {
    cached = null;
  },
};
