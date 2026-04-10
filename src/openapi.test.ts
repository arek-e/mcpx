import { describe, test, expect } from "bun:test";

import { extractTools, buildRequest, type OpenApiTool } from "./openapi.js";

const minimalSpec = {
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        summary: "List all pets",
        parameters: [
          {
            name: "limit",
            in: "query" as const,
            required: false,
            schema: { type: "integer" },
          },
        ],
      },
      post: {
        operationId: "createPet",
        summary: "Create a pet",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  tag: { type: "string" },
                },
                required: ["name"],
              },
            },
          },
        },
      },
    },
    "/pets/{petId}": {
      get: {
        operationId: "getPet",
        summary: "Get a pet by ID",
        parameters: [
          {
            name: "petId",
            in: "path" as const,
            required: true,
            schema: { type: "string" },
          },
        ],
      },
    },
    "/internal": {
      get: {
        // No operationId — should be skipped
        summary: "Internal endpoint",
      },
    },
  },
};

describe("extractTools", () => {
  test("extracts tools from operations with operationId", () => {
    const tools = extractTools(minimalSpec);
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual(["listPets", "createPet", "getPet"]);
  });

  test("skips operations without operationId", () => {
    const tools = extractTools(minimalSpec);
    expect(tools.find((t) => t.name === "Internal endpoint")).toBeUndefined();
  });

  test("maps path parameters as required", () => {
    const tools = extractTools(minimalSpec);
    const getPet = tools.find((t) => t.name === "getPet")!;
    expect(getPet.inputSchema.required).toEqual(["petId"]);
    expect((getPet.inputSchema.properties as Record<string, unknown>).petId).toBeTruthy();
  });

  test("maps query parameters", () => {
    const tools = extractTools(minimalSpec);
    const listPets = tools.find((t) => t.name === "listPets")!;
    expect((listPets.inputSchema.properties as Record<string, unknown>).limit).toBeTruthy();
  });

  test("maps request body properties", () => {
    const tools = extractTools(minimalSpec);
    const createPet = tools.find((t) => t.name === "createPet")!;
    const props = createPet.inputSchema.properties as Record<string, unknown>;
    expect(props.name).toBeTruthy();
    expect(props.tag).toBeTruthy();
    expect(createPet.inputSchema.required).toContain("name");
  });

  test("sets correct HTTP method", () => {
    const tools = extractTools(minimalSpec);
    expect(tools.find((t) => t.name === "listPets")!.method).toBe("GET");
    expect(tools.find((t) => t.name === "createPet")!.method).toBe("POST");
  });
});

describe("buildRequest", () => {
  test("substitutes path parameters", () => {
    const tool: OpenApiTool = {
      name: "getPet",
      description: "Get a pet",
      inputSchema: {},
      method: "GET",
      path: "/pets/{petId}",
      parameterMap: [{ name: "petId", in: "path", required: true }],
    };
    const { url } = buildRequest(tool, { petId: "123" }, "https://api.example.com");
    expect(url).toBe("https://api.example.com/pets/123");
  });

  test("appends query parameters", () => {
    const tool: OpenApiTool = {
      name: "listPets",
      description: "List pets",
      inputSchema: {},
      method: "GET",
      path: "/pets",
      parameterMap: [{ name: "limit", in: "query", required: false }],
    };
    const { url } = buildRequest(tool, { limit: 10 }, "https://api.example.com");
    expect(url).toBe("https://api.example.com/pets?limit=10");
  });

  test("sends body as JSON for POST", () => {
    const tool: OpenApiTool = {
      name: "createPet",
      description: "Create a pet",
      inputSchema: {},
      method: "POST",
      path: "/pets",
      parameterMap: [
        { name: "name", in: "body", required: true },
        { name: "tag", in: "body", required: false },
      ],
    };
    const { url, init } = buildRequest(
      tool,
      { name: "Fido", tag: "dog" },
      "https://api.example.com",
    );
    expect(url).toBe("https://api.example.com/pets");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      name: "Fido",
      tag: "dog",
    });
  });

  test("merges custom headers", () => {
    const tool: OpenApiTool = {
      name: "listPets",
      description: "",
      inputSchema: {},
      method: "GET",
      path: "/pets",
      parameterMap: [],
    };
    const { init } = buildRequest(tool, {}, "https://api.example.com", {
      Authorization: "Bearer token",
    });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token");
  });

  test("strips trailing slash from baseUrl", () => {
    const tool: OpenApiTool = {
      name: "listPets",
      description: "",
      inputSchema: {},
      method: "GET",
      path: "/pets",
      parameterMap: [],
    };
    const { url } = buildRequest(tool, {}, "https://api.example.com/");
    expect(url).toBe("https://api.example.com/pets");
  });
});

describe("$ref resolution", () => {
  test("resolves component schema references", () => {
    const specWithRefs = {
      paths: {
        "/pets": {
          post: {
            operationId: "createPet",
            summary: "Create",
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Pet" },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Pet: {
            type: "object",
            properties: {
              name: { type: "string" },
              age: { type: "integer" },
            },
            required: ["name"],
          },
        },
      },
    };

    const tools = extractTools(specWithRefs);
    expect(tools).toHaveLength(1);
    const props = tools[0].inputSchema.properties as Record<string, unknown>;
    expect(props.name).toBeTruthy();
    expect(props.age).toBeTruthy();
    expect(tools[0].inputSchema.required).toContain("name");
  });
});
