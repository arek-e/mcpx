import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { z } from "zod";

import { createAuthVerifier, filterBackendsByClaims, type AuthClaims } from "./auth.js";
import {
  connectBackends,
  generateTypeDefinitions,
  generateToolListing,
  refreshAllTools,
  type Backend,
} from "./backends.js";
import { loadConfig } from "./config.js";
import { executeCode } from "./executor.js";
import { startStdioServer } from "./stdio.js";
import { watchConfig } from "./watcher.js";

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
let backends: Map<string, import("./backends.js").Backend>;
try {
  backends = await connectBackends(config.backends);
} catch (err) {
  console.error(`Failed to connect backends: ${(err as Error).message}`);
  process.exit(1);
}

if (backends.size === 0 && !config.failOpen) {
  console.error(
    "No backends connected. Check that your backend commands are installed and accessible.\n  Use failOpen: true in config to start anyway.",
  );
  process.exit(1);
}

if (backends.size === 0) {
  console.warn("Warning: no backends connected (failOpen mode — server will start degraded)");
}

// Pre-generate type definitions and tool listing (mutable for hot-reload + tool refresh)
let typeDefs = generateTypeDefinitions(backends);
let toolListing = generateToolListing(backends);

let totalTools = Array.from(backends.values()).reduce((sum, b) => sum + b.tools.length, 0);
console.log(`\n${totalTools} tools from ${backends.size} backends → 2 Code Mode tools`);

// Periodic tool refresh
if (config.toolRefreshInterval && config.toolRefreshInterval > 0) {
  setInterval(async () => {
    try {
      await refreshAllTools(backends);
      typeDefs = generateTypeDefinitions(backends);
      toolListing = generateToolListing(backends);
      totalTools = Array.from(backends.values()).reduce((sum, b) => sum + b.tools.length, 0);
    } catch (err) {
      console.error("Tool refresh failed:", (err as Error).message);
    }
  }, config.toolRefreshInterval * 1000);
}

// Hot-reload: watch config file for changes
watchConfig(configPath, backends, (newConfig, diff) => {
  config = newConfig;
  typeDefs = generateTypeDefinitions(backends);
  toolListing = generateToolListing(backends);
  totalTools = Array.from(backends.values()).reduce((sum, b) => sum + b.tools.length, 0);
  console.log(
    `Config reloaded: +${diff.added.length} -${diff.removed.length} ~${diff.changed.length} (${totalTools} tools)`,
  );
});

// Create the MCP server with 2 Code Mode tools
function createMcpServer(visibleBackends: Map<string, Backend>): McpServer {
  const server = new McpServer({
    name: "mcpx",
    version: VERSION,
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

      for (const [name, backend] of visibleBackends) {
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
              text: `No tools found matching "${query}". Available backends: ${Array.from(visibleBackends.keys()).join(", ")}`,
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
      const result = await executeCode(code, visibleBackends);

      if (result.isErr()) {
        const e = result.error;
        const msg = e.kind === "runtime" ? `Execution failed with code ${e.code}` : e.message;
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text:
              typeof result.value === "string"
                ? result.value
                : JSON.stringify(result.value, null, 2),
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
    status: backends.size === 0 ? "degraded" : "ok",
    version: VERSION,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    backends: backendDetails,
    totalTools,
  });
});

// Auth middleware — JWT, bearer, or open
const verifier = createAuthVerifier(config);
if (verifier) {
  app.use("/mcp", async (c, next) => {
    const authHeader = c.req.header("Authorization");
    const token = authHeader?.replace(/^Bearer\s+/i, "");
    if (!token) return c.json({ error: "unauthorized" }, 401);

    const result = await verifier(token);
    if (result.isErr()) return c.json({ error: result.error }, 401);

    // Store claims for per-backend filtering
    c.set("claims" as never, result.value as never);
    await next();
  });
}

// Session management for stateful MCP connections
const sessions = new Map<
  string,
  {
    server: McpServer;
    transport: WebStandardStreamableHTTPServerTransport;
    lastAccess: number;
  }
>();
const sessionTtlMs = (config.sessionTtlMinutes ?? 30) * 60 * 1000;

// Expire stale sessions every minute
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastAccess > sessionTtlMs) {
      sessions.delete(id);
    }
  }
}, 60_000);

// MCP endpoint — Streamable HTTP with session support
app.all("/mcp", async (c) => {
  // Resolve visible backends based on auth claims
  const claims = c.get("claims" as never) as AuthClaims | undefined;
  const visibleBackends = claims
    ? filterBackendsByClaims(backends, claims, config.backends)
    : backends;

  const sessionId = c.req.header("mcp-session-id");

  // Reuse existing session
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    session.lastAccess = Date.now();
    const response = await session.transport.handleRequest(c.req.raw);
    return response;
  }

  // New session
  const server = createMcpServer(visibleBackends);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });

  await server.connect(transport);

  // Store session after first response (which contains the session ID)
  const response = await transport.handleRequest(c.req.raw);

  const newSessionId = response.headers.get("mcp-session-id");
  if (newSessionId) {
    sessions.set(newSessionId, { server, transport, lastAccess: Date.now() });
  }

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
