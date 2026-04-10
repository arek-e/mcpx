import { describe, test, expect } from "bun:test";

import { SignJWT } from "jose";

import { createAuthVerifier, filterBackendsByClaims, type AuthClaims } from "./auth.js";
import type { Backend } from "./backends.js";
import type { McpxConfig, BackendConfig } from "./config.js";

function makeConfig(overrides: Partial<McpxConfig> = {}): McpxConfig {
  return { port: 3100, backends: {}, ...overrides };
}

function makeMockBackend(name: string): [string, Backend] {
  return [name, { name, client: {} as Backend["client"], tools: [] }];
}

describe("createAuthVerifier", () => {
  test("returns null when no auth configured", () => {
    const verifier = createAuthVerifier(makeConfig());
    expect(verifier).toBeNull();
  });

  test("validates simple bearer token (legacy authToken)", async () => {
    const verifier = createAuthVerifier(makeConfig({ authToken: "secret" }));
    expect(verifier).not.toBeNull();

    const ok = await verifier!("secret");
    expect(ok.isOk()).toBe(true);

    const fail = await verifier!("wrong");
    expect(fail.isErr()).toBe(true);
  });

  test("validates simple bearer token (auth.bearer)", async () => {
    const verifier = createAuthVerifier(makeConfig({ auth: { bearer: "my-token" } }));
    expect(verifier).not.toBeNull();

    const ok = await verifier!("my-token");
    expect(ok.isOk()).toBe(true);
  });

  test("validates JWT with HMAC secret", async () => {
    const secret = "test-secret-at-least-32-chars-long!!";
    const verifier = createAuthVerifier(makeConfig({ auth: { jwt: { secret } } }));
    expect(verifier).not.toBeNull();

    const token = await new SignJWT({
      sub: "user-1",
      email: "test@example.com",
      roles: ["admin"],
    })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(secret));

    const result = await verifier!(token);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.sub).toBe("user-1");
      expect(result.value.email).toBe("test@example.com");
      expect(result.value.roles).toEqual(["admin"]);
    }
  });

  test("rejects expired JWT", async () => {
    const secret = "test-secret-at-least-32-chars-long!!";
    const verifier = createAuthVerifier(makeConfig({ auth: { jwt: { secret } } }));

    const token = await new SignJWT({ sub: "user-1" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("-1h") // already expired
      .sign(new TextEncoder().encode(secret));

    const result = await verifier!(token);
    expect(result.isErr()).toBe(true);
  });

  test("rejects JWT with wrong secret", async () => {
    const verifier = createAuthVerifier(
      makeConfig({
        auth: { jwt: { secret: "correct-secret-at-least-32-chars!!" } },
      }),
    );

    const token = await new SignJWT({ sub: "user-1" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("wrong-secret-at-least-32-chars!!!"));

    const result = await verifier!(token);
    expect(result.isErr()).toBe(true);
  });
});

describe("filterBackendsByClaims", () => {
  const backends = new Map<string, Backend>([
    makeMockBackend("grafana"),
    makeMockBackend("github"),
    makeMockBackend("public"),
  ]);

  const configs: Record<string, BackendConfig> = {
    grafana: {
      transport: "stdio",
      command: "grafana-mcp",
      allowedRoles: ["admin", "devops"],
    },
    github: {
      transport: "stdio",
      command: "github-mcp",
      allowedTeams: ["platform"],
    },
    public: { transport: "stdio", command: "public-mcp" },
  };

  test("returns all backends when no restrictions", () => {
    const noRestrictions: Record<string, BackendConfig> = {
      grafana: { transport: "stdio", command: "grafana-mcp" },
      github: { transport: "stdio", command: "github-mcp" },
      public: { transport: "stdio", command: "public-mcp" },
    };
    const claims: AuthClaims = { sub: "user" };
    const filtered = filterBackendsByClaims(backends, claims, noRestrictions);
    expect(filtered.size).toBe(3);
  });

  test("filters by role", () => {
    const claims: AuthClaims = { roles: ["admin"] };
    const filtered = filterBackendsByClaims(backends, claims, configs);
    expect(filtered.has("grafana")).toBe(true);
    expect(filtered.has("github")).toBe(false); // needs team, not role
    expect(filtered.has("public")).toBe(true); // no restrictions
  });

  test("filters by team", () => {
    const claims: AuthClaims = { teams: ["platform"] };
    const filtered = filterBackendsByClaims(backends, claims, configs);
    expect(filtered.has("grafana")).toBe(false); // needs role
    expect(filtered.has("github")).toBe(true);
    expect(filtered.has("public")).toBe(true);
  });

  test("excludes when no matching claims", () => {
    const claims: AuthClaims = { roles: ["viewer"], teams: ["marketing"] };
    const filtered = filterBackendsByClaims(backends, claims, configs);
    expect(filtered.has("grafana")).toBe(false);
    expect(filtered.has("github")).toBe(false);
    expect(filtered.has("public")).toBe(true);
  });
});
