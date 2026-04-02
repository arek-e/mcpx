import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = join(tmpdir(), `mcpx-test-${Date.now()}.json`);
  });

  afterEach(() => {
    try {
      unlinkSync(tmpFile);
    } catch {
      // ignore if already deleted
    }
  });

  test("loads minimal config with defaults", () => {
    writeFileSync(
      tmpFile,
      JSON.stringify({
        backends: {},
      }),
    );

    const config = loadConfig(tmpFile);
    expect(config.port).toBe(3100);
    expect(config.authToken).toBeUndefined();
    expect(config.backends).toEqual({});
  });

  test("loads port and authToken", () => {
    writeFileSync(
      tmpFile,
      JSON.stringify({
        port: 4000,
        authToken: "secret-token",
        backends: {},
      }),
    );

    const config = loadConfig(tmpFile);
    expect(config.port).toBe(4000);
    expect(config.authToken).toBe("secret-token");
  });

  test("interpolates ${VAR} from process.env in authToken", () => {
    process.env.TEST_AUTH_TOKEN = "from-env-token";
    writeFileSync(
      tmpFile,
      JSON.stringify({
        authToken: "${TEST_AUTH_TOKEN}",
        backends: {},
      }),
    );

    const config = loadConfig(tmpFile);
    expect(config.authToken).toBe("from-env-token");
    delete process.env.TEST_AUTH_TOKEN;
  });

  test("interpolates ${VAR} in backend env values", () => {
    process.env.MY_API_KEY = "key-from-env";
    writeFileSync(
      tmpFile,
      JSON.stringify({
        backends: {
          myserver: {
            transport: "stdio",
            command: "echo",
            env: {
              API_KEY: "${MY_API_KEY}",
              STATIC: "literal-value",
            },
          },
        },
      }),
    );

    const config = loadConfig(tmpFile);
    expect(config.backends.myserver.env?.API_KEY).toBe("key-from-env");
    expect(config.backends.myserver.env?.STATIC).toBe("literal-value");
    delete process.env.MY_API_KEY;
  });

  test("replaces missing env vars with empty string", () => {
    delete process.env.MISSING_VAR;
    writeFileSync(
      tmpFile,
      JSON.stringify({
        backends: {
          srv: {
            transport: "stdio",
            command: "echo",
            env: { KEY: "${MISSING_VAR}" },
          },
        },
      }),
    );

    const config = loadConfig(tmpFile);
    expect(config.backends.srv.env?.KEY).toBe("");
  });

  test("throws on missing file", () => {
    expect(() => loadConfig("/tmp/does-not-exist-mcpx.json")).toThrow();
  });

  test("throws on invalid JSON", () => {
    writeFileSync(tmpFile, "not valid json {{{");
    expect(() => loadConfig(tmpFile)).toThrow();
  });

  test("loads empty backends", () => {
    writeFileSync(tmpFile, JSON.stringify({ backends: {} }));
    const config = loadConfig(tmpFile);
    expect(Object.keys(config.backends)).toHaveLength(0);
  });

  test("loads multiple backends", () => {
    writeFileSync(
      tmpFile,
      JSON.stringify({
        backends: {
          grafana: { transport: "stdio", command: "grafana-mcp" },
          github: { transport: "stdio", command: "github-mcp", args: ["--token", "abc"] },
        },
      }),
    );

    const config = loadConfig(tmpFile);
    expect(Object.keys(config.backends)).toHaveLength(2);
    expect(config.backends.grafana.command).toBe("grafana-mcp");
    expect(config.backends.github.args).toEqual(["--token", "abc"]);
  });

  test("falls back to MCPX_AUTH_TOKEN env if authToken not in config", () => {
    process.env.MCPX_AUTH_TOKEN = "env-fallback-token";
    writeFileSync(tmpFile, JSON.stringify({ backends: {} }));

    const config = loadConfig(tmpFile);
    expect(config.authToken).toBe("env-fallback-token");
    delete process.env.MCPX_AUTH_TOKEN;
  });
});
