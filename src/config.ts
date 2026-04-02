import { readFileSync } from 'node:fs';

export interface BackendConfig {
  /** Transport: stdio spawns a subprocess, http connects to a remote MCP server */
  transport: 'stdio' | 'http';
  /** For stdio: command to run */
  command?: string;
  /** For stdio: arguments */
  args?: string[];
  /** For http: URL of the remote MCP server */
  url?: string;
  /** Environment variables (stdio) or headers (http) — supports ${VAR} interpolation from process.env */
  env?: Record<string, string>;
}

export interface McpxConfig {
  /** Port to listen on */
  port: number;
  /** Bearer token for authentication (optional) */
  authToken?: string;
  /** Backend MCP servers */
  backends: Record<string, BackendConfig>;
}

/** Interpolate ${VAR} references from process.env */
function interpolate(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '');
}

function interpolateRecord(record: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    result[k] = interpolate(v);
  }
  return result;
}

export function loadConfig(path: string): McpxConfig {
  const raw = readFileSync(path, 'utf-8');

  // Simple YAML-like parser for our config format
  // For production, use a proper YAML parser — keeping deps minimal for now
  const parsed = JSON.parse(raw);

  const config: McpxConfig = {
    port: parsed.port ?? 3100,
    authToken: parsed.authToken ? interpolate(parsed.authToken) : process.env.MCPX_AUTH_TOKEN,
    backends: {},
  };

  for (const [name, backend] of Object.entries(parsed.backends as Record<string, BackendConfig>)) {
    config.backends[name] = {
      ...backend,
      env: backend.env ? interpolateRecord(backend.env) : undefined,
    };
  }

  return config;
}
