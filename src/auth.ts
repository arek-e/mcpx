import { jwtVerify, createRemoteJWKSet, type JWTPayload } from "jose";
import { ok, err, type Result } from "neverthrow";

import type { Backend } from "./backends.js";
import type { McpxConfig, BackendConfig } from "./config.js";

export interface AuthClaims {
  sub?: string;
  email?: string;
  roles?: string[];
  teams?: string[];
}

type VerifyFn = (token: string) => Promise<Result<AuthClaims, string>>;

function extractClaims(payload: JWTPayload): AuthClaims {
  return {
    sub: payload.sub,
    email: payload.email as string | undefined,
    roles: (payload.roles ?? payload.role) as string[] | undefined,
    teams: (payload.teams ?? payload.team) as string[] | undefined,
  };
}

/** Create a token verification function based on config */
export function createAuthVerifier(config: McpxConfig): VerifyFn | null {
  const auth = config.auth;
  const legacyToken = config.authToken;

  // No auth configured
  if (!auth && !legacyToken) return null;

  // Simple bearer token (legacy authToken or auth.bearer)
  const bearerToken = auth?.bearer ?? legacyToken;
  if (bearerToken && !auth?.jwt) {
    return async (token: string) => {
      if (token !== bearerToken) return err("invalid token");
      return ok({});
    };
  }

  // JWT verification
  const jwt = auth?.jwt;
  if (!jwt) return null;

  const verifyOptions: { audience?: string; issuer?: string } = {};
  if (jwt.audience) verifyOptions.audience = jwt.audience;
  if (jwt.issuer) verifyOptions.issuer = jwt.issuer;

  if (jwt.jwksUrl) {
    const jwks = createRemoteJWKSet(new URL(jwt.jwksUrl));
    return async (token: string) => {
      try {
        const { payload } = await jwtVerify(token, jwks, verifyOptions);
        return ok(extractClaims(payload));
      } catch (e) {
        return err((e as Error).message);
      }
    };
  }

  if (jwt.secret) {
    const secret = new TextEncoder().encode(jwt.secret);
    return async (token: string) => {
      try {
        const { payload } = await jwtVerify(token, secret, verifyOptions);
        return ok(extractClaims(payload));
      } catch (e) {
        return err((e as Error).message);
      }
    };
  }

  return null;
}

/** Filter backends by JWT claims (roles/teams) */
export function filterBackendsByClaims(
  backends: Map<string, Backend>,
  claims: AuthClaims,
  configs: Record<string, BackendConfig>,
): Map<string, Backend> {
  const filtered = new Map<string, Backend>();

  for (const [name, backend] of backends) {
    const config = configs[name];
    if (!config) continue;

    // No restrictions — allow access
    if (!config.allowedRoles?.length && !config.allowedTeams?.length) {
      filtered.set(name, backend);
      continue;
    }

    // Check role intersection
    if (config.allowedRoles?.length) {
      const hasRole = claims.roles?.some((r) => config.allowedRoles!.includes(r));
      if (hasRole) {
        filtered.set(name, backend);
        continue;
      }
    }

    // Check team intersection
    if (config.allowedTeams?.length) {
      const hasTeam = claims.teams?.some((t) => config.allowedTeams!.includes(t));
      if (hasTeam) {
        filtered.set(name, backend);
        continue;
      }
    }
  }

  return filtered;
}
