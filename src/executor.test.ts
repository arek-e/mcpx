import { describe, test, expect } from "bun:test";
import { executeCode } from "./executor.js";
import type { Backend } from "./backends.js";

// Full integration tests with real MCP backends are deferred — they require running
// subprocess MCP servers. These tests cover the executor logic with empty backends.

describe("executeCode", () => {
  const emptyBackends = new Map<string, Backend>();

  test("returns simple value with no tool calls", async () => {
    const result = await executeCode("return 42;", emptyBackends);
    expect(result.success).toBe(true);
    expect(result.result).toBe(42);
  });

  test("returns string value", async () => {
    const result = await executeCode('return "hello world";', emptyBackends);
    expect(result.success).toBe(true);
    expect(result.result).toBe("hello world");
  });

  test("returns object value", async () => {
    const result = await executeCode('return { key: "value", num: 1 };', emptyBackends);
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ key: "value", num: 1 });
  });

  test("returns array value", async () => {
    const result = await executeCode("return [1, 2, 3];", emptyBackends);
    expect(result.success).toBe(true);
    expect(result.result).toEqual([1, 2, 3]);
  });

  test("handles async computation", async () => {
    const result = await executeCode(
      "const x = await Promise.resolve(10); return x * 2;",
      emptyBackends,
    );
    expect(result.success).toBe(true);
    expect(result.result).toBe(20);
  });

  test("returns null for code with no return", async () => {
    const result = await executeCode("const x = 1;", emptyBackends);
    expect(result.success).toBe(true);
    // undefined return becomes null
    expect(result.result == null).toBe(true);
  });

  test("handles syntax error gracefully", async () => {
    const result = await executeCode("{{{{invalid syntax", emptyBackends);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("handles runtime error gracefully", async () => {
    const result = await executeCode('throw new Error("something went wrong");', emptyBackends);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("with empty backends, no tool functions are injected", async () => {
    // Code that checks for absence of tool functions
    const result = await executeCode(
      "return typeof nonexistent_tool === 'undefined' ? 'no-tools' : 'has-tools';",
      emptyBackends,
    );
    expect(result.success).toBe(true);
    expect(result.result).toBe("no-tools");
  });

  // Note: full integration tests with real tool calls require running MCP subprocess servers.
  // Deferred to a future executor.integration.test.ts file.
});
