import { Plugin } from "obsidian";
import { updatePluginData } from "./pluginData";

export interface StoredMeasurement {
  id: string;
  // Endpoints in model-local coordinates (so they survive rolls & reloads).
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
}

interface DataShape {
  measurements?: Record<string, StoredMeasurement[]>;
}

/**
 * Persists pinned measurements in the plugin's data.json, keyed by the STEP
 * file's vault path (mirrors AnnotationStore). Reading the whole data blob
 * before writing preserves the sibling `annotations` field.
 */
export class MeasurementStore {
  constructor(private plugin: Plugin) {}

  async get(path: string): Promise<StoredMeasurement[]> {
    const data = (await this.plugin.loadData()) as DataShape | null;
    return data?.measurements?.[path] ?? [];
  }

  async set(path: string, list: StoredMeasurement[]): Promise<void> {
    await updatePluginData(this.plugin, (raw) => {
      const data = raw as DataShape;
      data.measurements = data.measurements ?? {};
      if (list.length) data.measurements[path] = list;
      else delete data.measurements[path];
    });
  }
}
