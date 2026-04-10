import type { Hono } from "hono";
import { SignJWT, jwtVerify } from "jose";

import type { AuthClaims } from "./auth.js";

export interface OAuthConfig {
  issuer: string;
  clients: Array<{ name: string; redirectUri: string }>;
  tokenSecret: string;
  tokenTtlMinutes: number;
}

interface RegisteredClient {
  clientId: string;
  clientSecret: string;
  name: string;
  redirectUri: string;
}

interface AuthorizationCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
  claims: AuthClaims;
}

// In-memory stores (single instance; back with Redis for multi-instance later)
const clients = new Map<string, RegisteredClient>();
const authCodes = new Map<string, AuthorizationCode>();

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function matchRedirectUri(pattern: string, uri: string): boolean {
  // Support wildcards: http://localhost:* matches http://localhost:9999/callback
  if (pattern.includes("*")) {
    const regex = new RegExp(
      `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
    );
    return regex.test(uri);
  }
  return pattern === uri;
}

/** Verify PKCE S256 challenge */
async function verifyPkce(codeVerifier: string, codeChallenge: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(codeVerifier));
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return base64 === codeChallenge;
}

/** Mount OAuth 2.0 endpoints on a Hono app */
export function createOAuthRoutes(config: OAuthConfig, app: Hono): void {
  const tokenSecret = new TextEncoder().encode(config.tokenSecret);

  // Pre-register configured clients
  for (const clientConfig of config.clients) {
    const client: RegisteredClient = {
      clientId: generateId(),
      clientSecret: generateId(),
      name: clientConfig.name,
      redirectUri: clientConfig.redirectUri,
    };
    clients.set(client.clientId, client);
  }

  // RFC 8414 — Authorization Server Metadata
  app.get("/.well-known/oauth-authorization-server", (c) => {
    const baseUrl = config.issuer;
    return c.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
      code_challenge_methods_supported: ["S256"],
    });
  });

  // RFC 7591 — Dynamic Client Registration
  app.post("/register", async (c) => {
    const body = await c.req.json();
    const name = body.client_name;
    const redirectUris = body.redirect_uris as string[] | undefined;
    const redirectUri = redirectUris?.[0];

    if (!name || !redirectUri) {
      return c.json({ error: "client_name and redirect_uris required" }, 400);
    }

    // Validate redirect URI against allowed patterns
    const allowed = config.clients.some((cc) => matchRedirectUri(cc.redirectUri, redirectUri));
    if (!allowed) {
      return c.json({ error: "redirect_uri not allowed" }, 400);
    }

    const client: RegisteredClient = {
      clientId: generateId(),
      clientSecret: generateId(),
      name,
      redirectUri,
    };
    clients.set(client.clientId, client);

    return c.json(
      {
        client_id: client.clientId,
        client_secret: client.clientSecret,
        client_name: client.name,
        redirect_uris: [client.redirectUri],
      },
      201,
    );
  });

  // Authorization endpoint
  app.get("/authorize", async (c) => {
    const clientId = c.req.query("client_id");
    const redirectUri = c.req.query("redirect_uri");
    const codeChallenge = c.req.query("code_challenge");
    const codeChallengeMethod = c.req.query("code_challenge_method");
    const state = c.req.query("state");

    if (!clientId || !redirectUri || !codeChallenge) {
      return c.json({ error: "client_id, redirect_uri, and code_challenge required" }, 400);
    }

    if (codeChallengeMethod && codeChallengeMethod !== "S256") {
      return c.json({ error: "only S256 code_challenge_method supported" }, 400);
    }

    const client = clients.get(clientId);
    if (!client) {
      return c.json({ error: "unknown client_id" }, 400);
    }

    if (!matchRedirectUri(client.redirectUri, redirectUri)) {
      return c.json({ error: "redirect_uri mismatch" }, 400);
    }

    // Check if caller already has a valid token (simple mode — no login page)
    const authHeader = c.req.header("Authorization");
    const existingToken = authHeader?.replace(/^Bearer\s+/i, "");
    let claims: AuthClaims = {};

    if (existingToken) {
      try {
        const { payload } = await jwtVerify(existingToken, tokenSecret);
        claims = {
          sub: payload.sub,
          email: payload.email as string | undefined,
          roles: payload.roles as string[] | undefined,
          teams: payload.teams as string[] | undefined,
        };
      } catch {
        // Invalid token — proceed with empty claims
      }
    }

    // Generate authorization code
    const code = generateId();
    authCodes.set(code, {
      code,
      clientId,
      redirectUri,
      codeChallenge,
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
      claims,
    });

    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (state) redirectUrl.searchParams.set("state", state);

    return c.redirect(redirectUrl.toString());
  });

  // Token endpoint
  app.post("/token", async (c) => {
    const body = await c.req.json();
    const { grant_type, code, redirect_uri, client_id, client_secret, code_verifier } = body;

    if (grant_type !== "authorization_code") {
      return c.json({ error: "unsupported_grant_type" }, 400);
    }

    if (!code || !redirect_uri || !client_id || !code_verifier) {
      return c.json({ error: "missing required parameters" }, 400);
    }

    // Validate client
    const client = clients.get(client_id);
    if (!client || (client_secret && client.clientSecret !== client_secret)) {
      return c.json({ error: "invalid_client" }, 401);
    }

    // Validate auth code
    const authCode = authCodes.get(code);
    if (!authCode) {
      return c.json({ error: "invalid_grant", error_description: "unknown code" }, 400);
    }

    authCodes.delete(code); // One-time use

    if (authCode.expiresAt < Date.now()) {
      return c.json({ error: "invalid_grant", error_description: "code expired" }, 400);
    }

    if (authCode.clientId !== client_id || authCode.redirectUri !== redirect_uri) {
      return c.json({ error: "invalid_grant", error_description: "parameter mismatch" }, 400);
    }

    // PKCE verification
    const pkceValid = await verifyPkce(code_verifier, authCode.codeChallenge);
    if (!pkceValid) {
      return c.json(
        {
          error: "invalid_grant",
          error_description: "PKCE verification failed",
        },
        400,
      );
    }

    // Issue access token
    const expiresIn = config.tokenTtlMinutes * 60;
    const accessToken = await new SignJWT({
      sub: authCode.claims.sub ?? "anonymous",
      email: authCode.claims.email,
      roles: authCode.claims.roles,
      teams: authCode.claims.teams,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(config.issuer)
      .setExpirationTime(`${config.tokenTtlMinutes}m`)
      .setIssuedAt()
      .sign(tokenSecret);

    return c.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
    });
  });
}

/** Get registered clients (for testing) */
export function getRegisteredClients(): Map<string, RegisteredClient> {
  return clients;
}

/** Clear stores (for testing) */
export function clearOAuthStores(): void {
  clients.clear();
  authCodes.clear();
}
