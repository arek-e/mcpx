import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { connectBackends, generateTypeDefinitions, generateToolListing } from "./backends.js";
import { executeCode } from "./executor.js";
import { startStdioServer } from "./stdio.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve version from package.json at startup
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8")) as {
  version: string;
};
const VERSION = pkg.version;

const command = process.argv[2];

// mcpx init [backend...]
if (command === "init") {
  const { runInit } = await import("./init.js");
  runInit(process.argv.slice(3));
  process.exit(0);
}

// mcpx stdio mcpx.json
if (command === "stdio") {
  const configPath = process.argv[3] ?? "mcpx.json";
  await startStdioServer(configPath);
  // Intentional: no process.exit() — StdioServerTransport keeps the event loop alive.
}

// HTTP server mode (default)
const configPath = process.argv[2] ?? "mcpx.json";

let config;
try {
  config = loadConfig(configPath);
} catch (err) {
  const msg =
    (err as NodeJS.ErrnoException).code === "ENOENT"
      ? `Config file not found: ${configPath}\n  Create it or pass the path as an argument: mcpx <config.json>`
      : `Failed to load config from ${configPath}: ${(err as Error).message}`;
  console.error(`mcpx startup error: ${msg}`);
  process.exit(1);
}

console.log("mcpx starting...");
console.log(`  version: ${VERSION}`);
console.log(`  config: ${configPath}`);
console.log(`  port: ${config.port}`);
console.log(`  backends: ${Object.keys(config.backends).join(", ")}`);

// Connect to all backend MCP servers
console.log("\nConnecting to backends:");
let backends;
try {
  backends = await connectBackends(config.backends);
} catch (err) {
  console.error(`Failed to connect backends: ${(err as Error).message}`);
  process.exit(1);
}

if (backends.size === 0) {
  console.error(
    "No backends connected. Check that your backend commands are installed and accessible.",
  );
  process.exit(1);
}

// Pre-generate type definitions and tool listing
const typeDefs = generateTypeDefinitions(backends);
const toolListing = generateToolListing(backends);

const totalTools = Array.from(backends.values()).reduce((sum, b) => sum + b.tools.length, 0);
console.log(`\n${totalTools} tools from ${backends.size} backends → 2 Code Mode tools`);

// Create the MCP server with 2 Code Mode tools
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "mcpx",
    version: VERSION,
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

// HTTP server with Hono
const app = new Hono();

// Record start time for uptime reporting
const startedAt = Date.now();

// Health check — includes uptime, version, and per-backend tool counts
app.get("/health", (c) => {
  const backendDetails = Array.from(backends.entries()).map(([name, backend]) => ({
    name,
    tools: backend.tools.length,
  }));

  return c.json({
    status: "ok",
    version: VERSION,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    backends: backendDetails,
    totalTools,
  });
});

// Auth middleware
if (config.authToken) {
  app.use("/mcp", async (c, next) => {
    const auth = c.req.header("Authorization");
    if (auth !== `Bearer ${config.authToken}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });
}

// MCP endpoint — Streamable HTTP
app.all("/mcp", async (c) => {
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // Stateless mode
  });

  await server.connect(transport);
  const response = await transport.handleRequest(c.req.raw);
  return response;
});

// Graceful shutdown — disconnect all backend clients before exiting
async function shutdown(signal: string): Promise<void> {
  console.log(`\nmcpx received ${signal}, shutting down...`);
  const disconnects = Array.from(backends.values()).map((b) =>
    b.client.close().catch((err: Error) => {
      console.error(`  failed to disconnect backend ${b.name}: ${err.message}`);
    }),
  );
  await Promise.allSettled(disconnects);
  console.log("mcpx shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

console.log(`\nmcpx listening on http://localhost:${config.port}`);
console.log(`  MCP endpoint: http://localhost:${config.port}/mcp`);
console.log(`  Health: http://localhost:${config.port}/health`);

export default {
  port: config.port,
  fetch: app.fetch,
};
