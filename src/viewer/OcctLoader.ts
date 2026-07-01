import occtimportjs, { OcctModule } from "occt-import-js";
// The .wasm is inlined into the bundle as a gzipped base64 string by the
// wasm-gzip esbuild plugin (see esbuild.config.mjs). Gzipping keeps the
// self-contained bundle under Obsidian Sync's 5 MB limit; it is inflated once,
// lazily, in `inflateWasm()`. Self-containment is required for BRAT (it only
// installs main.js/manifest.json/styles.css).
import wasmGzBase64 from "occt-import-js/dist/occt-import-js.wasm";

/** Inflate the gzipped base64 WASM payload into raw bytes for emscripten. */
async function inflateWasm(): Promise<Uint8Array> {
  const gz = Uint8Array.from(atob(wasmGzBase64), (c) => c.charCodeAt(0));
  const stream = new Blob([gz])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Singleton wrapper around the occt-import-js WASM module.
 *
 * The module is compiled/instantiated *lazily* — only on the first STEP file
 * open, never in the plugin's `onload()` (design doc §2.1). The resulting
 * promise is cached so the multi-MB WASM is inflated and compiled at most once
 * per session.
 *
 * The WASM bytes are passed to emscripten via `wasmBinary`, so it never tries
 * to `fetch`/`locateFile` the file — which is unreliable inside Obsidian and
 * differs across desktop/mobile (design doc §6.1, §11.4).
 */
let cached: Promise<OcctModule> | null = null;

export const OcctLoader = {
  get(): Promise<OcctModule> {
    if (!cached) {
      cached = inflateWasm()
        .then((wasmBinary) => occtimportjs({ wasmBinary }))
        .catch((err) => {
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
