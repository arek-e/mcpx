import { readFileSync } from "node:fs";

export interface BackendConfig {
  /** Transport: stdio spawns a subprocess, http connects to a remote MCP server */
  transport: "stdio" | "http";
  /** For stdio: command to run */
  command?: string;
  /** For stdio: arguments */
  args?: string[];
  /** For http: URL of the remote MCP server */
  url?: string;
  /** Environment variables for stdio subprocess — supports ${VAR} interpolation from process.env */
  env?: Record<string, string>;
  /** HTTP headers for http transport — supports ${VAR} interpolation */
  headers?: Record<string, string>;
  /** JWT roles allowed to access this backend */
  allowedRoles?: string[];
  /** JWT teams allowed to access this backend */
  allowedTeams?: string[];
}

export interface McpxConfig {
  /** Port to listen on */
  port: number;
  /** Bearer token for authentication (optional) */
  authToken?: string;
  /** Allow startup with 0 connected backends (default: false) */
  failOpen?: boolean;
  /** Interval in seconds to refresh tool lists from backends (0 = disabled) */
  toolRefreshInterval?: number;
  /** Auth configuration */
  auth?: {
    /** Simple bearer token */
    bearer?: string;
    /** JWT verification */
    jwt?: {
      /** HMAC symmetric secret */
      secret?: string;
      /** JWKS endpoint for asymmetric keys */
      jwksUrl?: string;
      /** Expected audience claim */
      audience?: string;
      /** Expected issuer claim */
      issuer?: string;
    };
  };
  /** Session TTL in minutes for HTTP mode (default: 30) */
  sessionTtlMinutes?: number;
  /** Backend MCP servers */
  backends: Record<string, BackendConfig>;
}

/** Interpolate ${VAR} references from process.env */
function interpolate(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
}

function interpolateRecord(record: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    result[k] = interpolate(v);
  }
  return result;
}

export function loadConfig(path: string): McpxConfig {
  const raw = readFileSync(path, "utf-8");

  // Simple YAML-like parser for our config format
  // For production, use a proper YAML parser — keeping deps minimal for now
  const parsed = JSON.parse(raw);

  // Normalize auth config (backward compat: authToken → auth.bearer)
  const legacyAuthToken = parsed.authToken
    ? interpolate(parsed.authToken)
    : process.env.MCPX_AUTH_TOKEN;

  const auth = parsed.auth
    ? {
        bearer: parsed.auth.bearer ? interpolate(parsed.auth.bearer) : undefined,
        jwt: parsed.auth.jwt
          ? {
              secret: parsed.auth.jwt.secret ? interpolate(parsed.auth.jwt.secret) : undefined,
              jwksUrl: parsed.auth.jwt.jwksUrl ? interpolate(parsed.auth.jwt.jwksUrl) : undefined,
              audience: parsed.auth.jwt.audience,
              issuer: parsed.auth.jwt.issuer,
            }
          : undefined,
      }
    : undefined;

  const config: McpxConfig = {
    port: parsed.port ?? 3100,
    authToken: legacyAuthToken,
    auth,
    failOpen: parsed.failOpen ?? false,
    toolRefreshInterval: parsed.toolRefreshInterval ?? 0,
    sessionTtlMinutes: parsed.sessionTtlMinutes ?? 30,
    backends: {},
  };

  for (const [name, backend] of Object.entries(parsed.backends as Record<string, BackendConfig>)) {
    config.backends[name] = {
      ...backend,
      env: backend.env ? interpolateRecord(backend.env) : undefined,
      headers: backend.headers ? interpolateRecord(backend.headers) : undefined,
    };
  }

  return config;
}
