// Web Worker that runs the occt-import-js STEP parse off the main thread.
//
// Why a worker (design: large-file support):
//  - The parse is a long synchronous WASM call; on the main thread it freezes
//    Obsidian's UI for the whole parse (tens of seconds on a ~100 MB model).
//  - occt-import-js' WASM heap is capped at 2 GB. Running it in a worker keeps
//    that budget isolated from the renderer's own JS heap (three.js scene +
//    Obsidian), and lets a hard OOM/abort surface as a worker error we can
//    catch instead of taking down the whole renderer.
//
// The WASM binary is NOT imported here — it is inflated once on the main thread
// (OcctLoader) and handed to this worker via the `init` message, so the ~7.6 MB
// payload is embedded in main.js only once.

import occtimportjs, {
  OcctModule,
  OcctReadParams,
  OcctResult,
  OcctMesh,
} from "occt-import-js";

// The worker global. We avoid pulling in the "WebWorker" TS lib (it clashes
// with "DOM") by typing only the members we use.
interface WorkerScope {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
const ctx = self as unknown as WorkerScope;

type InitMessage = { type: "init"; wasmBinary: Uint8Array };
type ParseMessage = {
  type: "parse";
  id: number;
  bytes: Uint8Array;
  params: OcctReadParams | null;
};
type InMessage = InitMessage | ParseMessage;

let modulePromise: Promise<OcctModule> | null = null;

// OCCT reports problems (including allocation failures) via emscripten's
// stdout/stderr, which we route here so failures come back with a diagnosis
// instead of a silent empty result.
let logs: string[] = [];

/** High-resolution timestamp, falling back to 0 if performance is unavailable. */
function now(): number {
  return typeof performance !== "undefined" ? performance.now() : 0;
}

/** Convert a mesh's plain-number arrays to typed arrays and collect transfers. */
function serialize(result: OcctResult): {
  result: OcctResult;
  transfer: Transferable[];
} {
  const transfer: Transferable[] = [];

  const meshes: OcctMesh[] = (result.meshes ?? []).map((mesh) => {
    const out: OcctMesh = { ...mesh };

    const pos = mesh.attributes?.position?.array;
    const nrm = mesh.attributes?.normal?.array;
    const idx = mesh.index?.array;

    const attributes: OcctMesh["attributes"] = { position: { array: [] } };
    if (pos) {
      const f = Float32Array.from(pos);
      attributes.position = { array: f };
      transfer.push(f.buffer);
    }
    if (nrm) {
      const f = Float32Array.from(nrm);
      attributes.normal = { array: f };
      transfer.push(f.buffer);
    }
    out.attributes = attributes;

    if (idx) {
      const u = Uint32Array.from(idx);
      out.index = { array: u };
      transfer.push(u.buffer);
    }
    return out;
  });

  return { result: { ...result, meshes }, transfer };
}

// onmessage must return void, so we hand off to an async handler and drop its
// promise (errors are reported back via postMessage inside the handler).
ctx.onmessage = (ev: MessageEvent): void => {
  void handleMessage(ev);
};

async function handleMessage(ev: MessageEvent): Promise<void> {
  const msg = ev.data as InMessage;

  if (msg.type === "init") {
    // Instantiate once; subsequent parse messages await this promise.
    // Route OCCT's stdout/stderr into `logs` for diagnostics.
    modulePromise = occtimportjs({
      wasmBinary: msg.wasmBinary,
      print: (s: string) => logs.push(s),
      printErr: (s: string) => logs.push(s),
    });
    return;
  }

  const { id, bytes, params } = msg;
  try {
    if (!modulePromise) throw new Error("occt worker received no init message");
    const occt = await modulePromise;
    logs = [];
    const t0 = now();
    const result = occt.ReadStepFile(bytes, params);
    const ms = Math.round(now() - t0);
    if (!result || !result.success) {
      ctx.postMessage({ id, ok: false, error: "occt success=false", logs, ms });
      return;
    }
    const meshCount = (result.meshes ?? []).length;
    const { result: serialized, transfer } = serialize(result);
    ctx.postMessage({ id, ok: true, result: serialized, meshCount, logs, ms }, transfer);
  } catch (err) {
    ctx.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      logs,
    });
  }
}
