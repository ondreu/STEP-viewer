import { Plugin } from "obsidian";

// One write chain per plugin instance, so overlapping saves run in sequence.
const chains = new WeakMap<Plugin, Promise<unknown>>();

/**
 * Serialized read-modify-write of the plugin's `data.json`. Independent stores
 * (annotations, measurements) each own a top-level field; because a write reads
 * the whole blob first, running them through one queue stops a stale read in one
 * store from clobbering a field another store just wrote.
 */
export function updatePluginData(
  plugin: Plugin,
  mutate: (data: Record<string, unknown>) => void,
): Promise<void> {
  const prev = chains.get(plugin) ?? Promise.resolve();
  const next = prev.then(async () => {
    const data = ((await plugin.loadData()) as Record<string, unknown> | null) ?? {};
    mutate(data);
    await plugin.saveData(data);
  });
  // Keep the chain alive even if one write rejects.
  chains.set(
    plugin,
    next.catch(() => undefined),
  );
  return next;
}
