import { watch } from "node:fs";

import { connectBackends, type Backend } from "./backends.js";
import { loadConfig, type McpxConfig, type BackendConfig } from "./config.js";

export interface ReloadResult {
  added: string[];
  removed: string[];
  changed: string[];
}

function diffBackends(
  oldConfigs: Record<string, BackendConfig>,
  newConfigs: Record<string, BackendConfig>,
): ReloadResult {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const name of Object.keys(newConfigs)) {
    if (!(name in oldConfigs)) {
      added.push(name);
    } else if (JSON.stringify(oldConfigs[name]) !== JSON.stringify(newConfigs[name])) {
      changed.push(name);
    }
  }

  for (const name of Object.keys(oldConfigs)) {
    if (!(name in newConfigs)) {
      removed.push(name);
    }
  }

  return { added, removed, changed };
}

/** Watch a config file and call onReload when it changes */
export function watchConfig(
  configPath: string,
  backends: Map<string, Backend>,
  onReload: (config: McpxConfig, result: ReloadResult) => void,
): () => void {
  let currentConfig = loadConfig(configPath);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const watcher = watch(configPath, () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        const newConfig = loadConfig(configPath);
        const diff = diffBackends(currentConfig.backends, newConfig.backends);

        if (!diff.added.length && !diff.removed.length && !diff.changed.length) {
          return; // No backend changes
        }

        // Remove deleted backends
        for (const name of diff.removed) {
          const backend = backends.get(name);
          if (backend) {
            await backend.client.close().catch(() => {});
            backends.delete(name);
          }
        }

        // Disconnect changed backends
        for (const name of diff.changed) {
          const backend = backends.get(name);
          if (backend) {
            await backend.client.close().catch(() => {});
            backends.delete(name);
          }
        }

        // Connect new + changed backends
        const toConnect: Record<string, BackendConfig> = {};
        for (const name of [...diff.added, ...diff.changed]) {
          toConnect[name] = newConfig.backends[name];
        }

        if (Object.keys(toConnect).length > 0) {
          const newBackends = await connectBackends(toConnect);
          for (const [name, backend] of newBackends) {
            backends.set(name, backend);
          }
        }

        currentConfig = newConfig;
        onReload(newConfig, diff);
      } catch (err) {
        console.error("Config reload failed:", (err as Error).message);
      }
    }, 500);
  });

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    watcher.close();
  };
}
