// Entrypoint for stdio mode — Claude Code runs this directly as a subprocess
// Usage: mcpx stdio mcpx.json
// Or: bunx mcpx stdio mcpx.json
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  connectBackends,
  generateTypeDefinitions,
  generateToolListing,
  refreshAllTools,
  type Backend,
} from "./backends.js";
import { loadConfig } from "./config.js";
import { executeCode } from "./executor.js";

export async function startStdioServer(configPath: string): Promise<void> {
  const config = loadConfig(configPath);

  // In stdio mode, log to stderr so stdout stays clean for MCP protocol
  process.stderr.write(`mcpx stdio starting...\n`);
  process.stderr.write(`  config: ${configPath}\n`);
  process.stderr.write(`  backends: ${Object.keys(config.backends).join(", ")}\n`);

  const backends = await connectBackends(config.backends);

  if (backends.size === 0 && !config.failOpen) {
    process.stderr.write("No backends connected. Use failOpen: true to start anyway.\n");
    process.exit(1);
  }

  if (backends.size === 0) {
    process.stderr.write("Warning: no backends connected (failOpen mode)\n");
  }

  let typeDefs = generateTypeDefinitions(backends);
  let toolListing = generateToolListing(backends);
  const totalTools = Array.from(backends.values()).reduce((sum, b) => sum + b.tools.length, 0);

  process.stderr.write(
    `\n${totalTools} tools from ${backends.size} backends -> 2 Code Mode tools\n`,
  );

  // Periodic tool refresh
  if (config.toolRefreshInterval && config.toolRefreshInterval > 0) {
    setInterval(async () => {
      try {
        await refreshAllTools(backends);
        typeDefs = generateTypeDefinitions(backends);
        toolListing = generateToolListing(backends);
      } catch (err) {
        process.stderr.write(`Tool refresh failed: ${(err as Error).message}\n`);
      }
    }, config.toolRefreshInterval * 1000);
  }

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
    {
      query: z.string().describe("Search query — tool name, backend name, or keyword"),
    },
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
  const result = await grafana.searchDashboards({ query: "pods" });
  return result;`,
    { code: z.string().describe("JavaScript async function body to execute") },
    async ({ code }) => {
      const result = await executeCode(code, backends);

      if (result.isErr()) {
        const e = result.error;
        let msg = e.kind === "runtime" ? `Execution failed with code ${e.code}` : e.message;
        if (e.kind === "parse" && e.snippet) {
          msg += `\n\n${e.snippet}`;
        }
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }

      const val = result.value.value;
      const text = typeof val === "string" ? val : JSON.stringify(val, null, 2);
      const logText =
        result.value.logs.length > 0
          ? `\n\n--- Console Output ---\n${result.value.logs.map((l) => `[${l.level}] ${l.args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`).join("\n")}`
          : "";

      return {
        content: [
          {
            type: "text" as const,
            text: text + logText,
          },
        ],
      };
    },
  );

  return server;
}
