import { describe, test, expect } from "bun:test";
import {
  generateTypeDefinitions,
  generateToolListing,
  sanitizeName,
  type Backend,
} from "./backends.js";

// Minimal mock backend factory
function makeMockBackend(name: string, tools: Backend["tools"]): [string, Backend] {
  return [
    name,
    {
      name,
      client: {} as Backend["client"],
      tools,
    },
  ];
}

describe("sanitizeName", () => {
  test("leaves alphanumeric and underscores unchanged", () => {
    expect(sanitizeName("my_tool_name")).toBe("my_tool_name");
    expect(sanitizeName("tool123")).toBe("tool123");
  });

  test("replaces hyphens with underscores", () => {
    expect(sanitizeName("my-tool")).toBe("my_tool");
  });

  test("replaces dots and slashes with underscores", () => {
    expect(sanitizeName("some.tool/name")).toBe("some_tool_name");
  });

  test("replaces spaces with underscores", () => {
    expect(sanitizeName("my tool")).toBe("my_tool");
  });

  test("handles already clean name", () => {
    expect(sanitizeName("cleanName")).toBe("cleanName");
  });

  test("handles empty string", () => {
    expect(sanitizeName("")).toBe("");
  });
});

describe("generateTypeDefinitions", () => {
  test("returns header comment for empty backends", () => {
    const backends = new Map<string, Backend>();
    const result = generateTypeDefinitions(backends);
    expect(result).toContain("Available MCP tool functions");
  });

  test("generates declare function for each tool", () => {
    const backends = new Map<string, Backend>([
      makeMockBackend("grafana", [
        {
          name: "search_dashboards",
          description: "Search dashboards",
          inputSchema: {
            properties: { query: { type: "string", description: "Search query" } },
            required: ["query"],
          },
        },
      ]),
    ]);

    const result = generateTypeDefinitions(backends);
    expect(result).toContain("declare function grafana_search_dashboards");
    expect(result).toContain("query: string");
    expect(result).toContain("Promise<any>");
  });

  test("marks optional params without required marker", () => {
    const backends = new Map<string, Backend>([
      makeMockBackend("mybackend", [
        {
          name: "my_tool",
          description: "A tool",
          inputSchema: {
            properties: {
              required_param: { type: "string" },
              optional_param: { type: "number" },
            },
            required: ["required_param"],
          },
        },
      ]),
    ]);

    const result = generateTypeDefinitions(backends);
    expect(result).toContain("required_param: string");
    expect(result).toContain("optional_param?: number");
  });

  test("uses any[] for array type params", () => {
    const backends = new Map<string, Backend>([
      makeMockBackend("srv", [
        {
          name: "bulk_op",
          description: "Bulk operation",
          inputSchema: {
            properties: { items: { type: "array" } },
            required: ["items"],
          },
        },
      ]),
    ]);

    const result = generateTypeDefinitions(backends);
    expect(result).toContain("items: any[]");
  });

  test("generates entries for multiple backends", () => {
    const backends = new Map<string, Backend>([
      makeMockBackend("alpha", [{ name: "do_a", description: "Do A", inputSchema: {} }]),
      makeMockBackend("beta", [{ name: "do_b", description: "Do B", inputSchema: {} }]),
    ]);

    const result = generateTypeDefinitions(backends);
    expect(result).toContain("// === alpha ===");
    expect(result).toContain("declare function alpha_do_a");
    expect(result).toContain("// === beta ===");
    expect(result).toContain("declare function beta_do_b");
  });

  test("sanitizes hyphens in tool names", () => {
    const backends = new Map<string, Backend>([
      makeMockBackend("srv", [
        { name: "my-hyphenated-tool", description: "A tool", inputSchema: {} },
      ]),
    ]);

    const result = generateTypeDefinitions(backends);
    expect(result).toContain("declare function srv_my_hyphenated_tool");
  });

  test("includes description snippet (up to 80 chars)", () => {
    const desc = "A very useful tool that does something important";
    const backends = new Map<string, Backend>([
      makeMockBackend("srv", [{ name: "tool", description: desc, inputSchema: {} }]),
    ]);

    const result = generateTypeDefinitions(backends);
    expect(result).toContain(desc);
  });
});

describe("generateToolListing", () => {
  test("returns empty string for no backends", () => {
    const backends = new Map<string, Backend>();
    expect(generateToolListing(backends)).toBe("");
  });

  test("lists tool with name and description", () => {
    const backends = new Map<string, Backend>([
      makeMockBackend("grafana", [
        {
          name: "search_dashboards",
          description: "Search dashboards by query",
          inputSchema: {},
        },
      ]),
    ]);

    const result = generateToolListing(backends);
    expect(result).toContain("grafana_search_dashboards");
    expect(result).toContain("Search dashboards by query");
  });

  test("truncates description to 60 chars", () => {
    const longDesc = "A".repeat(100);
    const backends = new Map<string, Backend>([
      makeMockBackend("srv", [{ name: "tool", description: longDesc, inputSchema: {} }]),
    ]);

    const result = generateToolListing(backends);
    const line = result.split("\n")[0];
    // description portion should be 60 chars
    expect(line).toContain("A".repeat(60));
    expect(line).not.toContain("A".repeat(61));
  });

  test("handles tool with no description", () => {
    const backends = new Map<string, Backend>([
      makeMockBackend("srv", [{ name: "no_desc_tool", inputSchema: {} }]),
    ]);

    const result = generateToolListing(backends);
    expect(result).toContain("srv_no_desc_tool: ");
  });

  test("generates one line per tool", () => {
    const backends = new Map<string, Backend>([
      makeMockBackend("srv", [
        { name: "tool_a", description: "Tool A", inputSchema: {} },
        { name: "tool_b", description: "Tool B", inputSchema: {} },
      ]),
    ]);

    const lines = generateToolListing(backends).split("\n");
    expect(lines).toHaveLength(2);
  });
});
