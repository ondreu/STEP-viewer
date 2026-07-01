import { Plugin } from "obsidian";

export interface StoredAnnotation {
  id: string;
  x: number;
  y: number;
  z: number; // anchor in model-local coordinates
  text: string;
  part?: string;
}

interface DataShape {
  annotations?: Record<string, StoredAnnotation[]>;
}

/**
 * Persists model annotations in the plugin's data.json, keyed by the STEP
 * file's vault path. Because the key is the file path, annotations are shared
 * between the full view and any note embed of the same model.
 *
 * We deliberately do not touch the .step file itself (design doc §1: no STEP
 * editing; the mesh is only an approximation of the real geometry).
 */
export class AnnotationStore {
  constructor(private plugin: Plugin) {}

  async get(path: string): Promise<StoredAnnotation[]> {
    const data = (await this.plugin.loadData()) as DataShape | null;
    return data?.annotations?.[path] ?? [];
  }

  async set(path: string, list: StoredAnnotation[]): Promise<void> {
    const data = ((await this.plugin.loadData()) as DataShape | null) ?? {};
    data.annotations = data.annotations ?? {};
    if (list.length) data.annotations[path] = list;
    else delete data.annotations[path];
    await this.plugin.saveData(data);
  }
}
