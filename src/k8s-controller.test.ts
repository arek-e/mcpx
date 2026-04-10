import { describe, test, expect } from "bun:test";

import { crdToConfig } from "./k8s-controller.js";

describe("crdToConfig", () => {
  test("converts empty resources to empty backends", () => {
    const config = crdToConfig(new Map());
    expect(config.backends).toEqual({});
    expect(config.port).toBe(3100);
    expect(config.failOpen).toBe(true);
  });

  test("converts stdio backend", () => {
    const resources = new Map([
      [
        "grafana",
        {
          transport: "stdio" as const,
          command: "uvx",
          args: ["mcp-grafana"],
          env: { GRAFANA_URL: "http://localhost:3333" },
        },
      ],
    ]);

    const config = crdToConfig(resources);
    expect(config.backends.grafana).toEqual({
      transport: "stdio",
      command: "uvx",
      args: ["mcp-grafana"],
      env: { GRAFANA_URL: "http://localhost:3333" },
      url: undefined,
      headers: undefined,
      allowedRoles: undefined,
      allowedTeams: undefined,
    });
  });

  test("converts http backend with headers", () => {
    const resources = new Map([
      [
        "remote",
        {
          transport: "http" as const,
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: "Bearer token" },
        },
      ],
    ]);

    const config = crdToConfig(resources);
    expect(config.backends.remote.transport).toBe("http");
    expect(config.backends.remote.url).toBe("https://mcp.example.com/mcp");
    expect(config.backends.remote.headers).toEqual({
      Authorization: "Bearer token",
    });
  });

  test("converts multiple backends", () => {
    const resources = new Map([
      ["grafana", { transport: "stdio" as const, command: "uvx", args: ["mcp-grafana"] }],
      [
        "github",
        {
          transport: "stdio" as const,
          command: "docker",
          args: ["run", "-i", "ghcr.io/github/github-mcp-server"],
        },
      ],
    ]);

    const config = crdToConfig(resources);
    expect(Object.keys(config.backends)).toHaveLength(2);
    expect(config.backends.grafana.command).toBe("uvx");
    expect(config.backends.github.command).toBe("docker");
  });

  test("preserves access control fields", () => {
    const resources = new Map([
      [
        "restricted",
        {
          transport: "stdio" as const,
          command: "mcp-server",
          allowedRoles: ["admin"],
          allowedTeams: ["platform"],
        },
      ],
    ]);

    const config = crdToConfig(resources);
    expect(config.backends.restricted.allowedRoles).toEqual(["admin"]);
    expect(config.backends.restricted.allowedTeams).toEqual(["platform"]);
  });

  test("applies base config overrides", () => {
    const resources = new Map();
    const config = crdToConfig(resources, {
      port: 4000,
      authToken: "my-token",
      sessionTtlMinutes: 60,
    });

    expect(config.port).toBe(4000);
    expect(config.authToken).toBe("my-token");
    expect(config.sessionTtlMinutes).toBe(60);
  });
});
