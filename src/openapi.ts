import type { Backend, ToolInfo } from "./backends.js";
import type { BackendConfig } from "./config.js";

interface OpenApiSpec {
  paths: Record<string, Record<string, OpenApiOperation>>;
  servers?: Array<{ url: string }>;
  components?: { schemas?: Record<string, unknown> };
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  requestBody?: { content?: { "application/json"?: { schema?: unknown } } };
}

interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header";
  required?: boolean;
  schema?: { type?: string; description?: string };
  description?: string;
}

interface ParameterMapping {
  name: string;
  in: "path" | "query" | "header" | "body";
  required: boolean;
}

export interface OpenApiTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  method: string;
  path: string;
  parameterMap: ParameterMapping[];
}

/** Fetch and parse an OpenAPI 3.x spec */
export async function loadOpenApiSpec(specUrl: string): Promise<OpenApiSpec> {
  const res = await fetch(specUrl);
  if (!res.ok) throw new Error(`Failed to fetch OpenAPI spec: ${res.status}`);
  return res.json();
}

/** Resolve a $ref to a schema definition */
function resolveRef(ref: string, spec: OpenApiSpec): unknown {
  const path = ref.replace("#/", "").split("/");
  let current: unknown = spec;
  for (const segment of path) {
    current = (current as Record<string, unknown>)?.[segment];
  }
  return current ?? {};
}

/** Recursively resolve $ref in a schema */
function resolveSchema(schema: unknown, spec: OpenApiSpec): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map((item) => resolveSchema(item, spec));
  const obj = schema as Record<string, unknown>;
  if (obj.$ref && typeof obj.$ref === "string") {
    return resolveSchema(resolveRef(obj.$ref, spec), spec);
  }
  const resolved: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "object" && v !== null) {
      resolved[k] = resolveSchema(v, spec);
    } else {
      resolved[k] = v;
    }
  }
  return resolved;
}

/** Extract MCP tools from an OpenAPI spec */
export function extractTools(spec: OpenApiSpec): OpenApiTool[] {
  const tools: OpenApiTool[] = [];

  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!operation.operationId) continue;

      const parameterMap: ParameterMapping[] = [];
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      // Path, query, header parameters
      for (const param of operation.parameters ?? []) {
        parameterMap.push({
          name: param.name,
          in: param.in,
          required: param.required ?? param.in === "path",
        });
        properties[param.name] = {
          type: param.schema?.type ?? "string",
          description: param.description ?? param.schema?.description,
        };
        if (param.required || param.in === "path") {
          required.push(param.name);
        }
      }

      // Request body
      const bodySchema = operation.requestBody?.content?.["application/json"]?.schema;
      if (bodySchema) {
        const resolved = resolveSchema(bodySchema, spec) as Record<string, unknown>;
        if (resolved.properties) {
          const bodyProps = resolved.properties as Record<string, unknown>;
          const bodyRequired = (resolved.required as string[]) ?? [];
          for (const [name, prop] of Object.entries(bodyProps)) {
            parameterMap.push({
              name,
              in: "body",
              required: bodyRequired.includes(name),
            });
            properties[name] = prop;
            if (bodyRequired.includes(name)) {
              required.push(name);
            }
          }
        }
      }

      tools.push({
        name: operation.operationId,
        description: operation.summary ?? operation.description?.slice(0, 120) ?? "",
        inputSchema: {
          type: "object",
          properties,
          ...(required.length > 0 ? { required } : {}),
        },
        method: method.toUpperCase(),
        path,
        parameterMap,
      });
    }
  }

  return tools;
}

/** Build an HTTP request from a tool call */
export function buildRequest(
  tool: OpenApiTool,
  args: Record<string, unknown>,
  baseUrl: string,
  headers?: Record<string, string>,
): { url: string; init: RequestInit } {
  let path = tool.path;
  const queryParams = new URLSearchParams();
  const bodyFields: Record<string, unknown> = {};
  const reqHeaders: Record<string, string> = { ...headers };

  for (const mapping of tool.parameterMap) {
    const value = args[mapping.name];
    if (value === undefined) continue;

    if (mapping.in === "path") {
      path = path.replace(`{${mapping.name}}`, encodeURIComponent(String(value)));
    } else if (mapping.in === "query") {
      queryParams.set(mapping.name, String(value));
    } else if (mapping.in === "header") {
      reqHeaders[mapping.name] = String(value);
    } else if (mapping.in === "body") {
      bodyFields[mapping.name] = value;
    }
  }

  const queryString = queryParams.toString();
  const url = `${baseUrl.replace(/\/$/, "")}${path}${queryString ? `?${queryString}` : ""}`;

  const init: RequestInit = {
    method: tool.method,
    headers: reqHeaders,
  };

  if (Object.keys(bodyFields).length > 0 && tool.method !== "GET") {
    init.body = JSON.stringify(bodyFields);
    reqHeaders["Content-Type"] = "application/json";
  }

  return { url, init };
}

/** Execute an OpenAPI tool call */
async function executeOpenApiTool(
  tool: OpenApiTool,
  args: Record<string, unknown>,
  baseUrl: string,
  headers?: Record<string, string>,
): Promise<unknown> {
  const { url, init } = buildRequest(tool, args, baseUrl, headers);
  const res = await fetch(url, init);
  const contentType = res.headers.get("content-type") ?? "";

  if (!res.ok) {
    const body = contentType.includes("json") ? await res.json() : await res.text();
    return { error: `HTTP ${res.status}`, body };
  }

  return contentType.includes("json") ? res.json() : res.text();
}

/** Create a Backend from an OpenAPI spec — no MCP client needed */
export async function createOpenApiBackend(name: string, config: BackendConfig): Promise<Backend> {
  const specUrl = config.specUrl ?? config.url;
  if (!specUrl) throw new Error(`Backend "${name}" missing specUrl or url`);

  const baseUrl = config.baseUrl ?? specUrl.replace(/\/[^/]*$/, "");
  const spec = await loadOpenApiSpec(specUrl);
  const openApiTools = extractTools(spec);

  console.log(`  ${name}: ${openApiTools.length} tools from OpenAPI spec`);

  const tools: ToolInfo[] = openApiTools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));

  // Proxy client that routes callTool to HTTP requests
  const toolMap = new Map(openApiTools.map((t) => [t.name, t]));
  const client = {
    callTool: async (params: { name: string; arguments?: Record<string, unknown> }) => {
      const tool = toolMap.get(params.name);
      if (!tool)
        return {
          content: [{ type: "text", text: `Unknown tool: ${params.name}` }],
        };
      const result = await executeOpenApiTool(
        tool,
        params.arguments ?? {},
        baseUrl,
        config.headers,
      );
      return {
        content: [
          {
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    },
    listTools: async () => ({ tools: tools.map((t) => ({ ...t })) }),
    close: async () => {},
    connect: async () => {},
  };

  return { name, client: client as unknown as Backend["client"], tools };
}
