import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

const presets: Record<string, object> = {
  grafana: {
    transport: "stdio",
    command: "uvx",
    args: ["mcp-grafana"],
    env: {
      GRAFANA_URL: "${GRAFANA_URL}",
      GRAFANA_SERVICE_ACCOUNT_TOKEN: "${GRAFANA_TOKEN}",
    },
  },
  plane: {
    transport: "stdio",
    command: "uvx",
    args: ["plane-mcp-server", "stdio"],
    env: {
      PLANE_API_KEY: "${PLANE_API_KEY}",
      PLANE_WORKSPACE_SLUG: "${PLANE_WORKSPACE_SLUG}",
      PLANE_BASE_URL: "${PLANE_BASE_URL}",
    },
  },
  github: {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: {
      GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}",
    },
  },
};

interface McpJsonServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
  url?: string;
}

/** Find and parse existing .mcp.json files from Claude Code */
function findExistingMcpConfigs(): Record<string, McpJsonServer> {
  const locations = [
    resolve(".mcp.json"), // project-level
    join(homedir(), ".claude.json"), // user-level
  ];

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
function convertToBackend(name: string, server: McpJsonServer): object | null {
  if (server.type === "http" || server.url) {
    return {
      transport: "http",
      url: server.url,
    };
  }

  if (server.command) {
    return {
      transport: "stdio",
      command: server.command,
      args: server.args ?? [],
      env: server.env,
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

  const mode = args?.[0];
  let backends: Record<string, object> = {};

  if (mode === "--import") {
    // Import from existing Claude Code .mcp.json
    console.log("Scanning for existing MCP server configs...");
    const existing = findExistingMcpConfigs();

    if (Object.keys(existing).length === 0) {
      console.log("  No existing configs found. Using presets instead.\n");
      backends = Object.fromEntries(Object.keys(presets).map((n) => [n, presets[n]]));
    } else {
      for (const [name, server] of Object.entries(existing)) {
        const backend = convertToBackend(name, server);
        if (backend) {
          backends[name] = backend;
          console.log(`  Imported: ${name}`);
        } else {
          console.log(`  Skipped: ${name} (unsupported config)`);
        }
      }
    }
  } else if (args?.length && !args[0].startsWith("-")) {
    // Selective presets: mcpx init grafana github
    const selected = args.filter((b) => presets[b]);
    if (selected.length === 0) {
      console.error(`No matching presets. Available: ${Object.keys(presets).join(", ")}`);
      process.exit(1);
    }
    backends = Object.fromEntries(selected.map((n) => [n, presets[n]]));
  } else {
    // Default: all presets
    backends = Object.fromEntries(Object.keys(presets).map((n) => [n, presets[n]]));
  }

  const config = {
    port: 3100,
    backends,
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  console.log(
    `\nCreated mcpx.json with ${Object.keys(backends).length} backends: ${Object.keys(backends).join(", ")}`,
  );
  console.log();
  console.log("Next steps:");
  console.log("  1. Set environment variables for your backends");
  console.log("  2. Run: mcpx stdio mcpx.json");
  console.log("  3. Or add to Claude Code:");
  console.log("     claude mcp add mcpx -- bunx mcpx-tools stdio mcpx.json");
  console.log();
  console.log("Commands:");
  console.log("  mcpx init                  — all presets (grafana, plane, github)");
  console.log("  mcpx init grafana github   — specific presets");
  console.log("  mcpx init --import         — import from existing .mcp.json");
}
