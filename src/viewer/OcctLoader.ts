import { Plugin, normalizePath } from "obsidian";
import occtimportjs, { OcctModule } from "occt-import-js";

/**
 * Singleton wrapper around the occt-import-js WASM module.
 *
 * The module is initialised *lazily* — only on the first STEP file open, never
 * in the plugin's `onload()` (design doc §2.1). The resulting promise is cached
 * so the multi-MB WASM is compiled at most once per session.
 *
 * WASM bytes are read from the plugin directory via the vault adapter and handed
 * to emscripten through `wasmBinary`, because `fetch`/`locateFile` against the
 * plugin directory is unreliable in Obsidian (design doc §6.1).
 */
let cached: Promise<OcctModule> | null = null;

export const OcctLoader = {
  get(plugin: Plugin): Promise<OcctModule> {
    if (!cached) {
      cached = init(plugin).catch((err) => {
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

async function init(plugin: Plugin): Promise<OcctModule> {
  const dir = plugin.manifest.dir;
  if (!dir) {
    throw new Error("Plugin manifest directory is unknown; cannot locate WASM.");
  }

  const wasmPath = normalizePath(`${dir}/occt-import-js.wasm`);
  const wasmBinary = await plugin.app.vault.adapter.readBinary(wasmPath);

  const occt = await occtimportjs({ wasmBinary });
  return occt;
}
