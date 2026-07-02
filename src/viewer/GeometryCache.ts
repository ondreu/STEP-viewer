import { OcctResult } from "../types";

/**
 * On-disk cache of parsed STEP geometry, keyed by file + quality.
 *
 * Parsing a large STEP in the WASM kernel is slow and deflection-independent
 * (the cost is in OCCT's reader/BREP transfer, not tessellation), so the only
 * way to make *reopening* a model fast is to skip OCCT entirely and reload the
 * geometry we already produced. We store the worker's serialized `OcctResult`
 * (typed-array buffers, hierarchy, colors) in IndexedDB.
 *
 * IndexedDB is deliberate: it lives in the app's storage, **outside the vault**,
 * so Obsidian Sync never touches it, and it's on disk (not RAM) with room for
 * large binary buffers via structured clone. Two object stores keep accounting
 * cheap: `meta` holds tiny {bytes, savedAt} records (scanned for size/LRU),
 * `geometry` holds the big payloads (only read on a hit).
 *
 * All operations degrade gracefully — any IndexedDB error resolves to a miss /
 * no-op so a cache problem can never block opening a model.
 */

/** Bump when the stored result shape changes, to invalidate old entries. */
export const CACHE_VERSION = 1;

/**
 * Only cache files at least this large. Small models parse in well under a
 * second, so caching them wastes space and (since a cache hit skips reading the
 * file) would needlessly drop their material metadata.
 */
export const CACHE_MIN_BYTES = 15 * 1024 * 1024;

const DB_NAME = "step-viewer";
const DB_VERSION = 1;
const STORE_GEOMETRY = "geometry";
const STORE_META = "meta";

interface MetaRecord {
  key: string;
  bytes: number;
  savedAt: number;
}

/** Build the cache key. `deflection` is included so a quality change re-parses. */
export function cacheKey(
  path: string,
  mtime: number,
  size: number,
  deflection: number,
): string {
  return `${path}|${mtime}|${size}|${deflection}|v${CACHE_VERSION}`;
}

/** Sum of the transferable buffer sizes in a result (for cache accounting). */
export function resultBytes(result: OcctResult): number {
  let n = 0;
  for (const m of result.meshes ?? []) {
    const pos = m.attributes?.position?.array;
    const nrm = m.attributes?.normal?.array;
    const idx = m.index?.array;
    if (pos && ArrayBuffer.isView(pos)) n += pos.byteLength;
    if (nrm && ArrayBuffer.isView(nrm)) n += nrm.byteLength;
    if (idx && ArrayBuffer.isView(idx)) n += idx.byteLength;
  }
  return n;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class GeometryCache {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB unavailable"));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_GEOMETRY)) {
          db.createObjectStore(STORE_GEOMETRY, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          const meta = db.createObjectStore(STORE_META, { keyPath: "key" });
          meta.createIndex("savedAt", "savedAt");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => {
      this.dbPromise = null; // allow a later retry
      throw err;
    });
    return this.dbPromise;
  }

  /** Return the cached result for `key`, or null on miss/error. Touches LRU time. */
  async get(key: string): Promise<OcctResult | null> {
    try {
      const db = await this.open();
      const tx = db.transaction([STORE_GEOMETRY, STORE_META], "readwrite");
      const rec = await promisify(
        tx.objectStore(STORE_GEOMETRY).get(key) as IDBRequest<
          { key: string; result: OcctResult } | undefined
        >,
      );
      if (!rec) return null;
      // Touch savedAt so recently used entries survive eviction (true LRU).
      const metaStore = tx.objectStore(STORE_META);
      const meta = await promisify(
        metaStore.get(key) as IDBRequest<MetaRecord | undefined>,
      );
      if (meta) metaStore.put({ ...meta, savedAt: Date.now() });
      return rec.result;
    } catch {
      return null;
    }
  }

  /** Store `result` under `key`. Fire-and-forget; errors are swallowed. */
  async put(key: string, result: OcctResult, bytes: number): Promise<void> {
    try {
      const db = await this.open();
      const tx = db.transaction([STORE_GEOMETRY, STORE_META], "readwrite");
      tx.objectStore(STORE_GEOMETRY).put({ key, result });
      tx.objectStore(STORE_META).put({ key, bytes, savedAt: Date.now() });
      await txDone(tx);
    } catch {
      /* ignore — caching is best-effort */
    }
  }

  /** Total cached bytes (from the small meta store). */
  async totalBytes(): Promise<number> {
    try {
      const db = await this.open();
      const tx = db.transaction(STORE_META, "readonly");
      const metas = await promisify(
        tx.objectStore(STORE_META).getAll() as IDBRequest<MetaRecord[]>,
      );
      return metas.reduce((sum, m) => sum + (m.bytes || 0), 0);
    } catch {
      return 0;
    }
  }

  /** Evict least-recently-used entries until total ≤ maxBytes. */
  async enforceCap(maxBytes: number): Promise<void> {
    try {
      const db = await this.open();
      const tx = db.transaction([STORE_GEOMETRY, STORE_META], "readwrite");
      const metaStore = tx.objectStore(STORE_META);
      const metas = await promisify(
        metaStore.getAll() as IDBRequest<MetaRecord[]>,
      );
      let total = metas.reduce((sum, m) => sum + (m.bytes || 0), 0);
      if (total <= maxBytes) return;
      metas.sort((a, b) => a.savedAt - b.savedAt); // oldest first
      const geoStore = tx.objectStore(STORE_GEOMETRY);
      for (const m of metas) {
        if (total <= maxBytes) break;
        geoStore.delete(m.key);
        metaStore.delete(m.key);
        total -= m.bytes || 0;
      }
      await txDone(tx);
    } catch {
      /* ignore */
    }
  }

  /** Drop the whole cache. */
  async clear(): Promise<void> {
    try {
      const db = await this.open();
      const tx = db.transaction([STORE_GEOMETRY, STORE_META], "readwrite");
      tx.objectStore(STORE_GEOMETRY).clear();
      tx.objectStore(STORE_META).clear();
      await txDone(tx);
    } catch {
      /* ignore */
    }
  }
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
