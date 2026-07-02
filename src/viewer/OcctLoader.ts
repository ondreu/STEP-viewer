import occtimportjs, { OcctModule, OcctReadParams, OcctResult } from "occt-import-js";
// The .wasm is inlined into the bundle as a gzipped base64 string by the
// wasm-gzip esbuild plugin (see esbuild.config.mjs). Gzipping keeps the
// self-contained bundle under Obsidian Sync's 5 MB limit; it is inflated once,
// lazily, in `inflateWasm()`. Self-containment is required for BRAT (it only
// installs main.js/manifest.json/styles.css).
import wasmGzBase64 from "occt-import-js/dist/occt-import-js.wasm";
// The occt worker, bundled to its full IIFE source string by the inline-worker
// esbuild plugin. Turned into a Blob-URL Worker at runtime so the plugin stays
// self-contained (no separate worker file to ship).
import workerCode from "./occt.worker?worker";

/** Inflate the gzipped base64 WASM payload into raw bytes for emscripten. */
async function inflateWasm(): Promise<Uint8Array> {
  const gz = Uint8Array.from(atob(wasmGzBase64), (c) => c.charCodeAt(0));
  const stream = new Blob([gz])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

let wasmPromise: Promise<Uint8Array> | null = null;
function getWasm(): Promise<Uint8Array> {
  if (!wasmPromise) {
    wasmPromise = inflateWasm().catch((err) => {
      wasmPromise = null;
      throw err;
    });
  }
  return wasmPromise;
}

// --- Main-thread module (fallback when Web Workers are unavailable) ----------

let cached: Promise<OcctModule> | null = null;
function getModule(): Promise<OcctModule> {
  if (!cached) {
    cached = getWasm()
      .then((wasmBinary) => occtimportjs({ wasmBinary }))
      .catch((err) => {
        cached = null;
        throw err;
      });
  }
  return cached;
}

// --- Worker-backed parsing ---------------------------------------------------

interface Pending {
  resolve: (result: OcctResult) => void;
  reject: (err: Error) => void;
}

let worker: Worker | null = null;
let workerUrl: string | null = null;
let workerInited = false;
let nextId = 1;
const pending = new Map<number, Pending>();

function workerSupported(): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof Blob !== "undefined" &&
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function"
  );
}

/** Reject every in-flight parse and dispose the worker so the next call is fresh. */
function destroyWorker(err?: Error): void {
  const e = err ?? new Error("occt worker terminated");
  for (const { reject } of pending.values()) reject(e);
  pending.clear();
  if (worker) {
    worker.terminate();
    worker = null;
  }
  if (workerUrl) {
    URL.revokeObjectURL(workerUrl);
    workerUrl = null;
  }
  workerInited = false;
}

function ensureWorker(): Worker {
  if (worker) return worker;
  workerUrl = URL.createObjectURL(
    new Blob([workerCode], { type: "text/javascript" }),
  );
  const w = new Worker(workerUrl);
  w.onmessage = (ev: MessageEvent) => {
    const msg = ev.data as
      | { id: number; ok: true; result: OcctResult }
      | { id: number; ok: false; error: string };
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.ok) {
      entry.resolve(msg.result);
    } else {
      // A failed parse can leave the WASM module in a poisoned state (e.g. after
      // an out-of-memory abort), so drop the worker; the next parse recreates it.
      entry.reject(new Error(msg.error));
      destroyWorker(new Error(msg.error));
    }
  };
  w.onerror = (ev: ErrorEvent) => {
    destroyWorker(new Error(ev.message || "occt worker crashed"));
  };
  worker = w;
  return w;
}

async function parseInWorker(
  bytes: Uint8Array,
  params: OcctReadParams,
): Promise<OcctResult> {
  const wasmBinary = await getWasm();
  const w = ensureWorker();
  if (!workerInited) {
    // Structured-cloned (not transferred) so the main thread keeps its copy for
    // a possible fallback. Ordered before any parse message, so the worker's
    // module promise is set by the time it handles the parse.
    w.postMessage({ type: "init", wasmBinary });
    workerInited = true;
  }
  const id = nextId++;
  return new Promise<OcctResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // Transfer the file bytes so they don't linger as a second copy on the main
    // thread during the parse. Callers must not touch `bytes` afterwards.
    w.postMessage({ type: "parse", id, bytes, params }, [bytes.buffer]);
  });
}

export const OcctLoader = {
  /**
   * Parse a STEP file into an occt result.
   *
   * Runs in a Web Worker when available (keeps the UI responsive and isolates
   * the 2 GB WASM heap from the renderer), otherwise synchronously on the main
   * thread. NOTE: on the worker path the input `bytes` buffer is transferred and
   * must not be used after this call — decode any text you need beforehand.
   */
  async parseStep(bytes: Uint8Array, params: OcctReadParams): Promise<OcctResult> {
    if (workerSupported()) {
      return parseInWorker(bytes, params);
    }
    const occt = await getModule();
    const result = occt.ReadStepFile(bytes, params);
    if (!result || !result.success) {
      throw new Error("Could not parse this STEP file (occt success=false).");
    }
    return result;
  },

  /** Testing/cleanup helper — drops cached module + worker. */
  reset(): void {
    cached = null;
    wasmPromise = null;
    destroyWorker();
  },
};
