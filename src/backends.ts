import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { BackendConfig } from "./config.js";
import { createOpenApiBackend } from "./openapi.js";

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface Backend {
  name: string;
  client: Client;
  tools: ToolInfo[];
}

/** Connect to a backend MCP server via stdio subprocess */
async function connectStdio(name: string, config: BackendConfig): Promise<Backend> {
  if (!config.command) throw new Error(`Backend "${name}" missing command`);

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: { ...process.env, ...config.env } as Record<string, string>,
  });

  const client = new Client({ name: `mcpx-${name}`, version: "0.1.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const toolInfos: ToolInfo[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as Record<string, unknown>,
  }));

  console.log(`  ${name}: ${toolInfos.length} tools connected`);
  return { name, client, tools: toolInfos };
}

/** Connect to a backend MCP server via HTTP (Streamable HTTP) */
async function connectHttp(name: string, config: BackendConfig): Promise<Backend> {
  if (!config.url) throw new Error(`Backend "${name}" missing url`);

  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: config.headers ? { headers: config.headers } : undefined,
  });

  const client = new Client({ name: `mcpx-${name}`, version: "0.1.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const toolInfos: ToolInfo[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as Record<string, unknown>,
  }));

  console.log(`  ${name}: ${toolInfos.length} tools connected (http)`);
  return { name, client, tools: toolInfos };
}

/** Connect to all configured backends */
export async function connectBackends(
  configs: Record<string, BackendConfig>,
): Promise<Map<string, Backend>> {
  const backends = new Map<string, Backend>();

  for (const [name, config] of Object.entries(configs)) {
    try {
      if (config.transport === "stdio") {
        const backend = await connectStdio(name, config);
        backends.set(name, backend);
      } else if (config.transport === "http") {
        const backend = await connectHttp(name, config);
        backends.set(name, backend);
      } else if (config.transport === "openapi") {
        const backend = await createOpenApiBackend(name, config);
        backends.set(name, backend);
      }
    } catch (err) {
      console.error(`  ${name}: failed to connect —`, (err as Error).message);
    }
  }

  return backends;
}

/** Refresh tool lists from a single backend */
async function refreshBackendTools(backend: Backend): Promise<void> {
  const { tools } = await backend.client.listTools();
  backend.tools = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as Record<string, unknown>,
  }));
}

/** Refresh tool lists from all backends */
export async function refreshAllTools(backends: Map<string, Backend>): Promise<void> {
  for (const [name, backend] of backends) {
    try {
      await refreshBackendTools(backend);
    } catch (err) {
      console.error(`  ${name}: tool refresh failed —`, (err as Error).message);
    }
  }
}

/** Map a JSON Schema type to a TypeScript type string */
function schemaTypeToTs(schema: Record<string, unknown>): string {
  const type = schema.type as string | undefined;
  if (schema.enum) return (schema.enum as unknown[]).map((v) => JSON.stringify(v)).join(" | ");
  if (type === "array") {
    const items = schema.items as Record<string, unknown> | undefined;
    return items ? `${schemaTypeToTs(items)}[]` : "any[]";
  }
  if (type === "object") {
    const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
    if (!props) return "Record<string, unknown>";
    const fields = Object.entries(props)
      .map(([k, v]) => `${k}: ${schemaTypeToTs(v)}`)
      .join("; ");
    return `{ ${fields} }`;
  }
  if (type === "string") return "string";
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  return "any";
}

/** Generate TypeScript type definitions from all backend tools for the LLM */
export function generateTypeDefinitions(backends: Map<string, Backend>): string {
  const lines: string[] = [
    "// Available tool functions — call via namespace: await backend.toolName(args)",
    "",
  ];

  for (const [name, backend] of backends) {
    lines.push(`// === ${name} ===`);
    for (const tool of backend.tools) {
      const props = tool.inputSchema?.properties as
        | Record<string, Record<string, unknown>>
        | undefined;
      const required = (tool.inputSchema?.required as string[]) ?? [];

      if (props && Object.keys(props).length > 0) {
        // Generate interface
        const ifaceName = `${name}_${sanitizeName(tool.name)}_Input`;
        lines.push(`interface ${ifaceName} {`);
        for (const [k, v] of Object.entries(props)) {
          const opt = required.includes(k) ? "" : "?";
          const desc = v.description ? ` // ${(v.description as string).slice(0, 60)}` : "";
          lines.push(`  ${k}${opt}: ${schemaTypeToTs(v)};${desc}`);
        }
        lines.push("}");

        const desc = tool.description ? ` — ${tool.description.slice(0, 80)}` : "";
        lines.push(
          `declare function ${name}_${sanitizeName(tool.name)}(args: ${ifaceName}): Promise<any>;${desc}`,
        );
      } else {
        const desc = tool.description ? ` — ${tool.description.slice(0, 80)}` : "";
        lines.push(
          `declare function ${name}_${sanitizeName(tool.name)}(args?: {}): Promise<any>;${desc}`,
        );
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

/** Generate a compact tool listing for the search tool description */
export function generateToolListing(backends: Map<string, Backend>): string {
  const lines: string[] = [];
  for (const [name, backend] of backends) {
    for (const tool of backend.tools) {
      const desc = tool.description?.slice(0, 60) ?? "";
      lines.push(`${name}_${sanitizeName(tool.name)}: ${desc}`);
    }
  }
  return lines.join("\n");
}

export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}
