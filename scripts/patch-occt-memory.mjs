// Raise occt-import-js' WASM heap ceiling from 2 GB to ~4 GB (the wasm32 max).
//
// Why: occt-import-js@0.0.23 ships prebuilt with a 2 GB memory cap. Large STEP
// assemblies exhaust it while loading the BREP model and the parse comes back
// "successful" but with empty geometry (a soft OOM). We can't raise the cap at
// runtime — it's baked into the .wasm memory section and the JS glue — so we
// patch both vendored artifacts here, before esbuild bundles them.
//
// Both edits are length-preserving, so no section sizes / offsets shift:
//   - .wasm memory limits: max pages 32768 (2 GB) -> 65535 (~4 GB). The LEB128
//     encodings 0x80 0x80 0x02 and 0xFF 0xFF 0x03 are both 3 bytes. We cap at
//     65535 (not 65536): a full 2^32-byte memory would exceed V8's Uint8Array
//     length limit when emscripten creates its HEAP views.
//   - JS glue: getHeapMax=()=>2147483648 -> ()=>4294901760 (= 65535*65536);
//     both numbers are 10 digits, so the string swap is length-preserving too.
//
// Idempotent, and fails loudly if the upstream bytes/strings change (so a
// dependency bump can't silently leave the cap at 2 GB).

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const dist = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../node_modules/occt-import-js/dist",
);
const JS = path.join(dist, "occt-import-js.js");
const WASM = path.join(dist, "occt-import-js.wasm");

const NEW_HEAP_MAX = 65535 * 65536; // 4294901760

// --- JS glue: getHeapMax ----------------------------------------------------
{
  const src = readFileSync(JS, "utf8");
  const already = `getHeapMax=()=>${NEW_HEAP_MAX}`;
  const original = "getHeapMax=()=>2147483648";
  if (src.includes(already)) {
    console.log("[patch-occt-memory] glue already patched");
  } else if (src.includes(original)) {
    writeFileSync(JS, src.replace(original, already));
    console.log(`[patch-occt-memory] glue: getHeapMax -> ${NEW_HEAP_MAX}`);
  } else {
    throw new Error(
      `[patch-occt-memory] could not find "${original}" in occt-import-js.js — ` +
        "the dependency changed; re-verify the memory cap before shipping.",
    );
  }
}

// --- .wasm: memory section max pages ---------------------------------------
{
  const buf = readFileSync(WASM);
  // Unique 6-byte memory-limits record: flag=01, min=457 (C9 03), max pages.
  const original = Buffer.from([0x01, 0xc9, 0x03, 0x80, 0x80, 0x02]); // max 32768
  const patched = Buffer.from([0x01, 0xc9, 0x03, 0xff, 0xff, 0x03]); // max 65535

  if (buf.includes(patched)) {
    console.log("[patch-occt-memory] wasm already patched");
  } else {
    const at = buf.indexOf(original);
    if (at === -1) {
      throw new Error(
        "[patch-occt-memory] memory-limits pattern not found in occt-import-js.wasm — " +
          "the dependency changed; re-verify the memory section before shipping.",
      );
    }
    // Guard against an ambiguous match (the pattern must be unique).
    if (buf.indexOf(original, at + 1) !== -1) {
      throw new Error("[patch-occt-memory] memory-limits pattern is not unique — aborting.");
    }
    patched.copy(buf, at);
    writeFileSync(WASM, buf);
    console.log(`[patch-occt-memory] wasm: memory max 32768 -> 65535 pages (@${at})`);
  }
}
