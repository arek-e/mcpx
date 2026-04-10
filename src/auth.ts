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

  // Build a list of verification strategies (tried in order)
  const strategies: VerifyFn[] = [];

  // Simple bearer token (legacy authToken or auth.bearer)
  const bearerToken = auth?.bearer ?? legacyToken;
  if (bearerToken) {
    strategies.push(async (token: string) => {
      if (token !== bearerToken) return err("invalid token");
      return ok({});
    });
  }

  // JWT with JWKS
  if (auth?.jwt?.jwksUrl) {
    const jwks = createRemoteJWKSet(new URL(auth.jwt.jwksUrl));
    const opts: { audience?: string; issuer?: string } = {};
    if (auth.jwt.audience) opts.audience = auth.jwt.audience;
    if (auth.jwt.issuer) opts.issuer = auth.jwt.issuer;
    strategies.push(async (token: string) => {
      try {
        const { payload } = await jwtVerify(token, jwks, opts);
        return ok(extractClaims(payload));
      } catch (e) {
        return err((e as Error).message);
      }
    });
  }

  // JWT with HMAC secret
  if (auth?.jwt?.secret) {
    const secret = new TextEncoder().encode(auth.jwt.secret);
    const opts: { audience?: string; issuer?: string } = {};
    if (auth.jwt.audience) opts.audience = auth.jwt.audience;
    if (auth.jwt.issuer) opts.issuer = auth.jwt.issuer;
    strategies.push(async (token: string) => {
      try {
        const { payload } = await jwtVerify(token, secret, opts);
        return ok(extractClaims(payload));
      } catch (e) {
        return err((e as Error).message);
      }
    });
  }

  // OAuth-issued tokens (signed with OAuth tokenSecret)
  if (auth?.oauth?.tokenSecret) {
    const oauthSecret = new TextEncoder().encode(auth.oauth.tokenSecret);
    strategies.push(async (token: string) => {
      try {
        const { payload } = await jwtVerify(token, oauthSecret, {
          issuer: auth.oauth!.issuer,
        });
        return ok(extractClaims(payload));
      } catch (e) {
        return err((e as Error).message);
      }
    });
  }

  if (strategies.length === 0) return null;

  // Try each strategy; return first success, or last error
  return async (token: string) => {
    let lastError = "invalid token";
    for (const strategy of strategies) {
      const result = await strategy(token);
      if (result.isOk()) return result;
      lastError = result.error;
    }
    return err(lastError);
  };
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
