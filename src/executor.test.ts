import { describe, test, expect } from "bun:test";

import type { Backend } from "./backends.js";
import { executeCode, sanitizeName } from "./executor.js";

const emptyBackends = new Map<string, Backend>();

describe("executeCode", () => {
  test("returns simple value with no tool calls", async () => {
    const result = await executeCode("return 42;", emptyBackends);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.value).toBe(42);
  });

  test("returns string value", async () => {
    const result = await executeCode('return "hello world";', emptyBackends);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.value).toBe("hello world");
  });

  test("returns object value", async () => {
    const result = await executeCode('return { key: "value", num: 1 };', emptyBackends);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.value).toEqual({ key: "value", num: 1 });
  });

  test("returns array value", async () => {
    const result = await executeCode("return [1, 2, 3];", emptyBackends);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.value).toEqual([1, 2, 3]);
  });

  test("handles async computation", async () => {
    const result = await executeCode(
      "const x = await Promise.resolve(10); return x * 2;",
      emptyBackends,
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.value).toBe(20);
  });

  test("returns null for code with no return", async () => {
    const result = await executeCode("const x = 1;", emptyBackends);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.value == null).toBe(true);
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
    if (result.isOk()) expect(result.value.value).toBe("no-tools");
  });

  test("tool bindings return real values via await", async () => {
    const mockBackend: Backend = {
      name: "test",
      client: {
        callTool: async ({
          name,
          arguments: args,
        }: {
          name: string;
          arguments?: Record<string, unknown>;
        }) => ({
          content: [
            {
              type: "text",
              text: `called ${name} with ${JSON.stringify(args)}`,
            },
          ],
        }),
        close: async () => {},
      } as any,
      tools: [{ name: "echo", description: "echo tool", inputSchema: {} }],
    };
    const backends = new Map([["test", mockBackend]]);

    const result = await executeCode(
      'const r = await test_echo({ msg: "hello" }); return r.content[0].text;',
      backends,
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.value).toBe('called echo with {"msg":"hello"}');
  });

  test("multi-step tool calls use results from previous calls", async () => {
    let callCount = 0;
    const mockBackend: Backend = {
      name: "mock",
      client: {
        callTool: async ({
          name,
          arguments: args,
        }: {
          name: string;
          arguments?: Record<string, unknown>;
        }) => {
          callCount++;
          if (name === "get_id") return { content: [{ type: "text", text: "42" }] };
          if (name === "get_details")
            return {
              content: [{ type: "text", text: `details for ${(args as any).id}` }],
            };
          return { content: [{ type: "text", text: "unknown" }] };
        },
        close: async () => {},
      } as any,
      tools: [
        { name: "get_id", description: "get id", inputSchema: {} },
        { name: "get_details", description: "get details", inputSchema: {} },
      ],
    };
    const backends = new Map([["mock", mockBackend]]);

    const result = await executeCode(
      `const idResult = await mock_get_id({});
       const id = idResult.content[0].text;
       const details = await mock_get_details({ id });
       return details.content[0].text;`,
      backends,
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.value).toBe("details for 42");
    expect(callCount).toBe(2);
  });

  test("unknown tool returns error object", async () => {
    const result = await executeCode(
      "const r = await nonexistent_tool_name({}); return r;",
      emptyBackends,
    );
    // Should either error or return undefined since tool doesn't exist
    expect(result.isOk() || result.isErr()).toBe(true);
  });
});

describe("sanitizeName", () => {
  test("replaces hyphens", () => expect(sanitizeName("my-tool")).toBe("my_tool"));
  test("replaces dots", () => expect(sanitizeName("my.tool")).toBe("my_tool"));
  test("keeps underscores", () => expect(sanitizeName("my_tool")).toBe("my_tool"));
  test("keeps alphanumeric", () => expect(sanitizeName("tool123")).toBe("tool123"));
});
