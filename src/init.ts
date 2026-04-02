import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const presets: Record<string, object> = {
  grafana: {
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-grafana'],
    env: {
      GRAFANA_URL: '${GRAFANA_URL}',
      GRAFANA_SERVICE_ACCOUNT_TOKEN: '${GRAFANA_TOKEN}',
    },
  },
  plane: {
    transport: 'stdio',
    command: 'uvx',
    args: ['plane-mcp-server', 'stdio'],
    env: {
      PLANE_API_KEY: '${PLANE_API_KEY}',
      PLANE_WORKSPACE_SLUG: '${PLANE_WORKSPACE_SLUG}',
      PLANE_BASE_URL: '${PLANE_BASE_URL}',
    },
  },
  github: {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: {
      GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}',
    },
  },
};

export function runInit(backends?: string[]) {
  const configPath = resolve('mcpx.json');

  if (existsSync(configPath)) {
    console.error(`mcpx.json already exists. Delete it first to re-initialize.`);
    process.exit(1);
  }

  const selected = backends?.length ? backends.filter((b) => presets[b]) : Object.keys(presets);

  const config = {
    port: 3100,
    backends: Object.fromEntries(selected.map((name) => [name, presets[name]])),
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  console.log(`Created mcpx.json with backends: ${selected.join(', ')}`);
  console.log();
  console.log('Next steps:');
  console.log('  1. Set environment variables for your backends');
  console.log('  2. Run: mcpx stdio mcpx.json');
  console.log(
    '  3. Or add to Claude Code: claude mcp add mcpx -- bunx mcpx-gateway stdio mcpx.json',
  );
  console.log();
  console.log('Available presets: ' + Object.keys(presets).join(', '));
}
