import { describe, test, expect } from "bun:test";
import { executeCode, sanitizeName } from "./executor.js";
import type { Backend } from "./backends.js";

const emptyBackends = new Map<string, Backend>();

describe("executeCode", () => {
  test("returns simple value with no tool calls", async () => {
    const result = await executeCode("return 42;", emptyBackends);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toBe(42);
  });

  test("returns string value", async () => {
    const result = await executeCode('return "hello world";', emptyBackends);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toBe("hello world");
  });

  test("returns object value", async () => {
    const result = await executeCode('return { key: "value", num: 1 };', emptyBackends);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual({ key: "value", num: 1 });
  });

  test("returns array value", async () => {
    const result = await executeCode("return [1, 2, 3];", emptyBackends);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual([1, 2, 3]);
  });

  test("handles async computation", async () => {
    const result = await executeCode(
      "const x = await Promise.resolve(10); return x * 2;",
      emptyBackends,
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toBe(20);
  });

  test("returns null for code with no return", async () => {
    const result = await executeCode("const x = 1;", emptyBackends);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value == null).toBe(true);
  });

  test("handles syntax error gracefully", async () => {
    const result = await executeCode("{{{{invalid syntax", emptyBackends);
    expect(result.isErr()).toBe(true);
  });

  test("handles runtime error gracefully", async () => {
    const result = await executeCode('throw new Error("something went wrong");', emptyBackends);
    expect(result.isErr()).toBe(true);
  });

  test("with empty backends, no tool functions are injected", async () => {
    const result = await executeCode(
      "return typeof nonexistent_tool === 'undefined' ? 'no-tools' : 'has-tools';",
      emptyBackends,
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toBe("no-tools");
  });
});

describe("sanitizeName", () => {
  test("replaces hyphens", () => expect(sanitizeName("my-tool")).toBe("my_tool"));
  test("replaces dots", () => expect(sanitizeName("my.tool")).toBe("my_tool"));
  test("keeps underscores", () => expect(sanitizeName("my_tool")).toBe("my_tool"));
  test("keeps alphanumeric", () => expect(sanitizeName("tool123")).toBe("tool123"));
});
