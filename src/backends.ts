import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { BackendConfig } from './config.js';

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
    env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
  });

  const client = new Client({ name: `mcpx-${name}`, version: '0.1.0' });
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

/** Connect to all configured backends */
export async function connectBackends(
  configs: Record<string, BackendConfig>,
): Promise<Map<string, Backend>> {
  const backends = new Map<string, Backend>();

  for (const [name, config] of Object.entries(configs)) {
    try {
      if (config.transport === 'stdio') {
        const backend = await connectStdio(name, config);
        backends.set(name, backend);
      } else if (config.transport === 'http') {
        // TODO: implement HTTP/SSE client transport
        console.log(`  ${name}: http transport not yet implemented, skipping`);
      }
    } catch (err) {
      console.error(`  ${name}: failed to connect —`, (err as Error).message);
    }
  }

  return backends;
}

/** Generate TypeScript type definitions from all backend tools for the LLM */
export function generateTypeDefinitions(backends: Map<string, Backend>): string {
  const lines: string[] = [
    '// Available MCP tool functions — call these in your execute code',
    '// Each function returns a Promise<{ content: Array<{ type: string, text: string }> }>',
    '',
  ];

  for (const [name, backend] of backends) {
    lines.push(`// === ${name} ===`);
    for (const tool of backend.tools) {
      const params = tool.inputSchema?.properties
        ? Object.entries(
            tool.inputSchema.properties as Record<string, { type?: string; description?: string }>,
          )
            .map(([k, v]) => {
              const required = (tool.inputSchema.required as string[] | undefined)?.includes(k);
              return `${k}${required ? '' : '?'}: ${v.type === 'array' ? 'any[]' : (v.type ?? 'any')}`;
            })
            .join(', ')
        : '';
      const desc = tool.description ? ` — ${tool.description.slice(0, 80)}` : '';
      lines.push(
        `declare function ${name}_${sanitizeName(tool.name)}(args: { ${params} }): Promise<any>;${desc}`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Generate a compact tool listing for the search tool description */
export function generateToolListing(backends: Map<string, Backend>): string {
  const lines: string[] = [];
  for (const [name, backend] of backends) {
    for (const tool of backend.tools) {
      const desc = tool.description?.slice(0, 60) ?? '';
      lines.push(`${name}_${sanitizeName(tool.name)}: ${desc}`);
    }
  }
  return lines.join('\n');
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}
