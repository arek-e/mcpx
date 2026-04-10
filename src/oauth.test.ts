import { describe, test, expect, beforeEach } from "bun:test";

import { Hono } from "hono";

import { createOAuthRoutes, clearOAuthStores, type OAuthConfig } from "./oauth.js";

const oauthConfig: OAuthConfig = {
  issuer: "https://mcp.test.com",
  clients: [{ name: "test-client", redirectUri: "http://localhost:*" }],
  tokenSecret: "test-oauth-secret-at-least-32-chars!!",
  tokenTtlMinutes: 60,
};

function createApp(): Hono {
  const app = new Hono();
  createOAuthRoutes(oauthConfig, app);
  return app;
}

async function generatePkce(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const verifier = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return { verifier, challenge };
}

beforeEach(() => {
  clearOAuthStores();
});

describe("OAuth metadata", () => {
  test("returns authorization server metadata", async () => {
    const app = createApp();
    const res = await app.request("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issuer).toBe("https://mcp.test.com");
    expect(body.authorization_endpoint).toBe("https://mcp.test.com/authorize");
    expect(body.token_endpoint).toBe("https://mcp.test.com/token");
    expect(body.registration_endpoint).toBe("https://mcp.test.com/register");
    expect(body.code_challenge_methods_supported).toContain("S256");
  });
});

describe("Client registration", () => {
  test("registers a new client", async () => {
    const app = createApp();
    const res = await app.request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "my-agent",
        redirect_uris: ["http://localhost:9999/callback"],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.client_id).toBeTruthy();
    expect(body.client_secret).toBeTruthy();
    expect(body.client_name).toBe("my-agent");
  });

  test("rejects unknown redirect URI", async () => {
    const app = createApp();
    const res = await app.request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "bad-agent",
        redirect_uris: ["https://evil.com/callback"],
      }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects missing fields", async () => {
    const app = createApp();
    const res = await app.request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("Full OAuth flow", () => {
  test("register → authorize → token exchange", async () => {
    const app = createApp();

    // 1. Register client
    const regRes = await app.request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "flow-test",
        redirect_uris: ["http://localhost:8888/cb"],
      }),
    });
    const { client_id, client_secret } = await regRes.json();

    // 2. Generate PKCE
    const { verifier, challenge } = await generatePkce();

    // 3. Authorize (should redirect with code)
    const authRes = await app.request(
      `/authorize?client_id=${client_id}&redirect_uri=${encodeURIComponent("http://localhost:8888/cb")}&code_challenge=${challenge}&code_challenge_method=S256&state=xyz`,
      { redirect: "manual" },
    );
    expect(authRes.status).toBe(302);
    const location = authRes.headers.get("location")!;
    const redirectUrl = new URL(location);
    const code = redirectUrl.searchParams.get("code");
    expect(code).toBeTruthy();
    expect(redirectUrl.searchParams.get("state")).toBe("xyz");

    // 4. Exchange code for token
    const tokenRes = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://localhost:8888/cb",
        client_id,
        client_secret,
        code_verifier: verifier,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = await tokenRes.json();
    expect(tokenBody.access_token).toBeTruthy();
    expect(tokenBody.token_type).toBe("Bearer");
    expect(tokenBody.expires_in).toBe(3600);
  });

  test("rejects wrong PKCE verifier", async () => {
    const app = createApp();

    const regRes = await app.request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "pkce-test",
        redirect_uris: ["http://localhost:7777/cb"],
      }),
    });
    const { client_id } = await regRes.json();

    const { challenge } = await generatePkce();

    const authRes = await app.request(
      `/authorize?client_id=${client_id}&redirect_uri=${encodeURIComponent("http://localhost:7777/cb")}&code_challenge=${challenge}`,
      { redirect: "manual" },
    );
    const location = authRes.headers.get("location")!;
    const code = new URL(location).searchParams.get("code");

    // Use wrong verifier
    const tokenRes = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://localhost:7777/cb",
        client_id,
        code_verifier: "wrong-verifier-that-doesnt-match",
      }),
    });
    expect(tokenRes.status).toBe(400);
    const body = await tokenRes.json();
    expect(body.error_description).toContain("PKCE");
  });

  test("rejects reused authorization code", async () => {
    const app = createApp();

    const regRes = await app.request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "reuse-test",
        redirect_uris: ["http://localhost:6666/cb"],
      }),
    });
    const { client_id } = await regRes.json();

    const { verifier, challenge } = await generatePkce();

    const authRes = await app.request(
      `/authorize?client_id=${client_id}&redirect_uri=${encodeURIComponent("http://localhost:6666/cb")}&code_challenge=${challenge}`,
      { redirect: "manual" },
    );
    const code = new URL(authRes.headers.get("location")!).searchParams.get("code");

    // First use — should succeed
    const tokenRes1 = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://localhost:6666/cb",
        client_id,
        code_verifier: verifier,
      }),
    });
    expect(tokenRes1.status).toBe(200);

    // Second use — should fail
    const tokenRes2 = await app.request("/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://localhost:6666/cb",
        client_id,
        code_verifier: verifier,
      }),
    });
    expect(tokenRes2.status).toBe(400);
  });
});
