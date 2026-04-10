/**
 * OAuth client for MCP HTTP backends.
 * Handles: metadata discovery, client registration, auth code + PKCE, token storage, refresh.
 * Tokens stored in .mcpx/tokens/{backend-name}.json
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  response_types_supported?: string[];
  grant_types_supported?: string[];
  code_challenge_methods_supported?: string[];
}

interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
}

interface PkceChallenge {
  verifier: string;
  challenge: string;
}

async function generatePkce(): Promise<PkceChallenge> {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const verifier = Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return { verifier, challenge };
}

/** Discover OAuth metadata from an MCP server */
async function discoverMetadata(serverUrl: string): Promise<OAuthMetadata> {
  const base = new URL(serverUrl);
  const metadataUrl = `${base.origin}/.well-known/oauth-authorization-server`;

  const res = await fetch(metadataUrl);
  if (!res.ok) {
    // Fall back to default endpoints
    return {
      issuer: base.origin,
      authorization_endpoint: `${base.origin}/authorize`,
      token_endpoint: `${base.origin}/token`,
      registration_endpoint: `${base.origin}/register`,
    };
  }
  return res.json();
}

/** Register as an OAuth client with the server */
async function registerClient(
  metadata: OAuthMetadata,
  redirectUri: string,
): Promise<{ clientId: string; clientSecret?: string }> {
  if (!metadata.registration_endpoint) {
    throw new Error("Server doesn't support dynamic client registration");
  }

  const res = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "mcpx",
      redirect_uris: [redirectUri],
    }),
  });

  if (!res.ok) {
    throw new Error(`Client registration failed: ${res.status} ${await res.text()}`);
  }

  const body = await res.json();
  return { clientId: body.client_id, clientSecret: body.client_secret };
}

/** Exchange authorization code for tokens */
async function exchangeCode(
  tokenEndpoint: string,
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string | undefined,
  codeVerifier: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number }> {
  const body: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  };
  if (clientSecret) body.client_secret = clientSecret;

  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in ?? 3600,
  };
}

/** Refresh an expired access token */
async function refreshAccessToken(
  tokenEndpoint: string,
  refreshToken: string,
  clientId: string,
  clientSecret?: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number }> {
  const body: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  };
  if (clientSecret) body.client_secret = clientSecret;

  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status}`);
  }

  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresIn: data.expires_in ?? 3600,
  };
}

function getTokenPath(tokensDir: string, backendName: string): string {
  return join(tokensDir, `${backendName}.json`);
}

function loadToken(tokensDir: string, backendName: string): StoredToken | null {
  const path = getTokenPath(tokensDir, backendName);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function saveToken(tokensDir: string, backendName: string, token: StoredToken): void {
  mkdirSync(tokensDir, { recursive: true });
  writeFileSync(getTokenPath(tokensDir, backendName), JSON.stringify(token, null, 2) + "\n");
}

/** Start a temporary local server to receive the OAuth callback */
function startCallbackServer(port: number): Promise<{ code: string; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${port}`);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          `<html><body><h2>Authorization failed: ${error}</h2><p>You can close this tab.</p></body></html>`,
        );
        reject(new Error(`OAuth error: ${error}`));
        server.close();
        return;
      }

      if (code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html><body><h2>Authorization successful!</h2><p>You can close this tab and return to the terminal.</p></body></html>",
        );
        resolve({ code, server });
        return;
      }

      res.writeHead(400);
      res.end("Missing code parameter");
    });

    server.listen(port, () => {
      // Server ready
    });

    server.on("error", reject);

    // Timeout after 5 minutes
    setTimeout(
      () => {
        server.close();
        reject(new Error("OAuth callback timeout (5 minutes)"));
      },
      5 * 60 * 1000,
    );
  });
}

export interface OAuthClientConfig {
  redirectUri?: string;
  callbackPort?: number;
}

/**
 * Get a valid access token for an HTTP backend.
 * Handles the full OAuth flow: discovery → registration → auth code → token exchange.
 * Caches tokens in .mcpx/tokens/ and refreshes when expired.
 */
export async function getAccessToken(
  backendName: string,
  serverUrl: string,
  tokensDir: string,
  oauthConfig: OAuthClientConfig = {},
): Promise<string> {
  const callbackPort = oauthConfig.callbackPort ?? 9876;
  const redirectUri = oauthConfig.redirectUri ?? `http://localhost:${callbackPort}/oauth/callback`;

  // Check for cached token
  const cached = loadToken(tokensDir, backendName);
  if (cached) {
    // Token still valid (with 60s buffer)
    if (cached.expiresAt > Date.now() + 60_000) {
      return cached.accessToken;
    }

    // Try refresh
    if (cached.refreshToken) {
      try {
        console.log(`  ${backendName}: refreshing OAuth token...`);
        const refreshed = await refreshAccessToken(
          cached.tokenEndpoint,
          cached.refreshToken,
          cached.clientId,
          cached.clientSecret,
        );
        const token: StoredToken = {
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          expiresAt: Date.now() + refreshed.expiresIn * 1000,
          clientId: cached.clientId,
          clientSecret: cached.clientSecret,
          tokenEndpoint: cached.tokenEndpoint,
        };
        saveToken(tokensDir, backendName, token);
        return token.accessToken;
      } catch {
        console.log(`  ${backendName}: refresh failed, re-authenticating...`);
      }
    }
  }

  // Full OAuth flow
  console.log(`  ${backendName}: discovering OAuth metadata...`);
  const metadata = await discoverMetadata(serverUrl);

  console.log(`  ${backendName}: registering OAuth client...`);
  const { clientId, clientSecret } = await registerClient(metadata, redirectUri);

  const pkce = await generatePkce();
  const state = crypto.randomUUID();

  const authUrl = new URL(metadata.authorization_endpoint);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("code_challenge", pkce.challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);

  // Start callback server and prompt user
  console.log(`\n  ${backendName}: authorize mcpx at:\n`);
  console.log(`  ${authUrl.toString()}\n`);
  console.log(`  Waiting for callback on ${redirectUri}...\n`);

  // Try to open browser automatically
  try {
    const open =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    Bun.spawn([open, authUrl.toString()], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // Manual open is fine
  }

  const { code, server } = await startCallbackServer(callbackPort);
  server.close();

  console.log(`  ${backendName}: exchanging code for token...`);
  const tokens = await exchangeCode(
    metadata.token_endpoint,
    code,
    redirectUri,
    clientId,
    clientSecret,
    pkce.verifier,
  );

  const stored: StoredToken = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: Date.now() + tokens.expiresIn * 1000,
    clientId,
    clientSecret,
    tokenEndpoint: metadata.token_endpoint,
  };
  saveToken(tokensDir, backendName, stored);
  console.log(`  ${backendName}: OAuth token saved`);

  return stored.accessToken;
}
