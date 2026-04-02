import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

interface McpJsonServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
  url?: string;
}

/** Find and parse existing .mcp.json files from Claude Code */
function findExistingMcpConfigs(): Record<string, McpJsonServer> {
  const locations = [resolve(".mcp.json"), join(homedir(), ".claude.json")];

  const servers: Record<string, McpJsonServer> = {};

  for (const path of locations) {
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8"));
      const mcpServers = raw.mcpServers ?? {};
      for (const [name, config] of Object.entries(mcpServers)) {
        servers[name] = config as McpJsonServer;
      }
      console.log(`  Found ${Object.keys(mcpServers).length} MCP servers in ${path}`);
    } catch {
      // skip unparseable files
    }
  }

  return servers;
}

/** Convert a Claude Code MCP server config to an mcpx backend config */
function convertToBackend(server: McpJsonServer): object | null {
  if (server.type === "http" || server.url) {
    return { transport: "http", url: server.url };
  }

  if (server.command) {
    return {
      transport: "stdio",
      command: server.command,
      args: server.args ?? [],
      ...(server.env ? { env: server.env } : {}),
    };
  }

  return null;
}

export function runInit(args?: string[]) {
  const configPath = resolve("mcpx.json");

  if (existsSync(configPath)) {
    console.error("mcpx.json already exists. Delete it first to re-initialize.");
    process.exit(1);
  }

  const isEmpty = args?.[0] === "--empty";
  let backends: Record<string, object> = {};

  if (isEmpty) {
    // Empty config — user fills in manually
    backends = {
      "my-server": {
        transport: "stdio",
        command: "npx",
        args: ["-y", "your-mcp-server"],
        env: { API_KEY: "${YOUR_API_KEY}" },
      },
    };
  } else {
    // Default: scan for existing MCP configs
    console.log("Scanning for existing MCP server configs...");
    const existing = findExistingMcpConfigs();

    if (Object.keys(existing).length === 0) {
      console.log("  No MCP servers found in .mcp.json or ~/.claude.json");
      console.log("  Creating empty config — edit mcpx.json to add your backends.\n");
      backends = {
        "my-server": {
          transport: "stdio",
          command: "npx",
          args: ["-y", "your-mcp-server"],
          env: { API_KEY: "${YOUR_API_KEY}" },
        },
      };
    } else {
      for (const [name, server] of Object.entries(existing)) {
        const backend = convertToBackend(server);
        if (backend) {
          backends[name] = backend;
          console.log(`  Imported: ${name}`);
        } else {
          console.log(`  Skipped: ${name} (unsupported config)`);
        }
      }
    }
  }

  const config = { port: 3100, backends };

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  const count = Object.keys(backends).length;
  console.log(`\nCreated mcpx.json with ${count} backend${count !== 1 ? "s" : ""}`);
  console.log();
  console.log("Next steps:");
  console.log("  1. Edit mcpx.json — add or configure your MCP backends");
  console.log("  2. Set environment variables referenced in the config");
  console.log("  3. Run: bunx mcpx-tools stdio mcpx.json");
}
