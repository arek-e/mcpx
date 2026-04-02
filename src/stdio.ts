// Entrypoint for stdio mode — Claude Code runs this directly as a subprocess
// Usage: mcpx stdio mcpx.json
// Or: bunx mcpx stdio mcpx.json
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import {
  connectBackends,
  generateTypeDefinitions,
  generateToolListing,
  type Backend,
} from "./backends.js";
import { executeCode } from "./executor.js";

export async function startStdioServer(configPath: string): Promise<void> {
  const config = loadConfig(configPath);

  // In stdio mode, log to stderr so stdout stays clean for MCP protocol
  process.stderr.write(`mcpx stdio starting...\n`);
  process.stderr.write(`  config: ${configPath}\n`);
  process.stderr.write(`  backends: ${Object.keys(config.backends).join(", ")}\n`);

  const backends = await connectBackends(config.backends);

  if (backends.size === 0) {
    process.stderr.write("No backends connected. Exiting.\n");
    process.exit(1);
  }

  const typeDefs = generateTypeDefinitions(backends);
  const toolListing = generateToolListing(backends);
  const totalTools = Array.from(backends.values()).reduce((sum, b) => sum + b.tools.length, 0);

  process.stderr.write(
    `\n${totalTools} tools from ${backends.size} backends -> 2 Code Mode tools\n`,
  );

  const server = createMcpServer(backends, typeDefs, toolListing);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write("mcpx stdio ready\n");
}

function createMcpServer(
  backends: Map<string, Backend>,
  typeDefs: string,
  toolListing: string,
): McpServer {
  const server = new McpServer({
    name: "mcpx",
    version: "0.1.0",
  });

  server.tool(
    "search",
    `Search available tools across all connected MCP servers. Returns type definitions for matched tools.

Available tools:
${toolListing}`,
    { query: z.string().describe("Search query — tool name, backend name, or keyword") },
    async ({ query }) => {
      const q = query.toLowerCase();
      const matched: string[] = [];

      for (const [name, backend] of backends) {
        for (const tool of backend.tools) {
          const fullName = `${name}_${tool.name}`;
          const desc = tool.description?.toLowerCase() ?? "";
          if (
            fullName.toLowerCase().includes(q) ||
            desc.includes(q) ||
            name.toLowerCase().includes(q)
          ) {
            const params = tool.inputSchema?.properties
              ? JSON.stringify(tool.inputSchema.properties, null, 2)
              : "{}";
            matched.push(`### ${fullName}\n${tool.description ?? ""}\nParameters: ${params}`);
          }
        }
      }

      if (matched.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No tools found matching "${query}". Available backends: ${Array.from(backends.keys()).join(", ")}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${matched.length} tools:\n\n${matched.join("\n\n")}`,
          },
        ],
      };
    },
  );

  server.tool(
    "execute",
    `Execute JavaScript code that calls MCP tools. The code runs in a V8 isolate.

Write an async function body. Available tool functions (call with await):
${typeDefs}

Example:
  const result = await grafana_search_dashboards({ query: "pods" });
  return result;`,
    { code: z.string().describe("JavaScript async function body to execute") },
    async ({ code }) => {
      const result = await executeCode(code, backends);

      if (!result.success) {
        return {
          content: [{ type: "text" as const, text: `Error: ${result.error}` }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text:
              typeof result.result === "string"
                ? result.result
                : JSON.stringify(result.result, null, 2),
          },
        ],
      };
    },
  );

  return server;
}
