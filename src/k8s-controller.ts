/**
 * Lightweight K8s controller that watches McpxBackend CRDs and generates mcpx.json.
 * Runs as a sidecar — pairs with config hot-reload to pick up changes automatically.
 *
 * Usage: bun src/k8s-controller.ts --namespace default --output /config/mcpx.json
 */
import { writeFileSync } from "node:fs";

import type { BackendConfig, McpxConfig } from "./config.js";

interface McpxBackendSpec {
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  allowedRoles?: string[];
  allowedTeams?: string[];
}

interface McpxBackendResource {
  metadata: { name: string; resourceVersion?: string };
  spec: McpxBackendSpec;
}

interface K8sWatchEvent {
  type: "ADDED" | "MODIFIED" | "DELETED";
  object: McpxBackendResource;
}

interface K8sListResponse {
  metadata: { resourceVersion: string };
  items: McpxBackendResource[];
}

/** Convert CRD resources to mcpx.json config */
export function crdToConfig(
  resources: Map<string, McpxBackendSpec>,
  baseConfig?: Partial<McpxConfig>,
): McpxConfig {
  const backends: Record<string, BackendConfig> = {};
  for (const [name, spec] of resources) {
    backends[name] = {
      transport: spec.transport,
      command: spec.command,
      args: spec.args,
      url: spec.url,
      env: spec.env,
      headers: spec.headers,
      allowedRoles: spec.allowedRoles,
      allowedTeams: spec.allowedTeams,
    };
  }

  return {
    port: baseConfig?.port ?? 3100,
    authToken: baseConfig?.authToken,
    auth: baseConfig?.auth,
    failOpen: baseConfig?.failOpen ?? true,
    toolRefreshInterval: baseConfig?.toolRefreshInterval,
    sessionTtlMinutes: baseConfig?.sessionTtlMinutes,
    backends,
  };
}

function parseArgs(args: string[]): {
  namespace: string;
  output: string;
  baseConfigPath?: string;
} {
  let namespace = "default";
  let output = "/config/mcpx.json";
  let baseConfigPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--namespace" && args[i + 1]) namespace = args[++i];
    else if (args[i] === "--output" && args[i + 1]) output = args[++i];
    else if (args[i] === "--base-config" && args[i + 1]) baseConfigPath = args[++i];
  }

  return { namespace, output, baseConfigPath };
}

async function k8sFetch(path: string): Promise<Response> {
  const host = process.env.KUBERNETES_SERVICE_HOST ?? "kubernetes.default.svc";
  const port = process.env.KUBERNETES_SERVICE_PORT ?? "443";
  const tokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token";
  const caPath = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

  let token: string;
  try {
    token = await Bun.file(tokenPath).text();
  } catch {
    throw new Error("Not running in K8s — service account token not found");
  }

  return fetch(`https://${host}:${port}${path}`, {
    headers: { Authorization: `Bearer ${token.trim()}` },
    tls: { ca: Bun.file(caPath) },
  } as RequestInit);
}

export async function startController(opts: {
  namespace: string;
  output: string;
  baseConfig?: Partial<McpxConfig>;
}): Promise<void> {
  const resources = new Map<string, McpxBackendSpec>();
  const apiPath = `/apis/mcpx.io/v1alpha1/namespaces/${opts.namespace}/mcpxbackends`;

  function writeConfig() {
    const config = crdToConfig(resources, opts.baseConfig);
    writeFileSync(opts.output, JSON.stringify(config, null, 2) + "\n");
    console.log(`Wrote ${opts.output} (${resources.size} backends)`);
  }

  // Initial list
  const listRes = await k8sFetch(apiPath);
  if (!listRes.ok) {
    throw new Error(`Failed to list McpxBackends: ${listRes.status} ${await listRes.text()}`);
  }

  const list: K8sListResponse = await listRes.json();
  for (const item of list.items) {
    resources.set(item.metadata.name, item.spec);
  }
  writeConfig();

  // Watch for changes
  let resourceVersion = list.metadata.resourceVersion;

  async function watch(): Promise<void> {
    while (true) {
      try {
        const watchRes = await k8sFetch(`${apiPath}?watch=true&resourceVersion=${resourceVersion}`);

        if (!watchRes.ok || !watchRes.body) {
          console.error(`Watch failed: ${watchRes.status}, reconnecting...`);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }

        const reader = watchRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.trim()) continue;
            const event: K8sWatchEvent = JSON.parse(line);

            if (event.type === "ADDED" || event.type === "MODIFIED") {
              resources.set(event.object.metadata.name, event.object.spec);
              console.log(`${event.type}: ${event.object.metadata.name}`);
            } else if (event.type === "DELETED") {
              resources.delete(event.object.metadata.name);
              console.log(`DELETED: ${event.object.metadata.name}`);
            }

            if (event.object.metadata.resourceVersion) {
              resourceVersion = event.object.metadata.resourceVersion;
            }

            writeConfig();
          }
        }
      } catch (err) {
        console.error("Watch error:", (err as Error).message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  await watch();
}

// CLI entrypoint
if (import.meta.main) {
  const { namespace, output, baseConfigPath } = parseArgs(process.argv.slice(2));

  let baseConfig: Partial<McpxConfig> | undefined;
  if (baseConfigPath) {
    const { loadConfig } = await import("./config.js");
    const full = loadConfig(baseConfigPath);
    baseConfig = { ...full, backends: {} };
  }

  console.log(`mcpx k8s controller starting...`);
  console.log(`  namespace: ${namespace}`);
  console.log(`  output: ${output}`);

  await startController({ namespace, output, baseConfig });
}
