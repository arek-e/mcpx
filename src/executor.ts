import { ok, err, type Result } from "neverthrow";
import { createNodeDriver, NodeExecutionDriver, type BindingFunction } from "secure-exec";

import { validateSyntax } from "./ast.js";
import type { Backend } from "./backends.js";

type ToolFunction = (args: Record<string, unknown>) => Promise<unknown>;

export interface LogEntry {
  level: "log" | "warn" | "error" | "info" | "debug";
  args: unknown[];
}

export interface ExecuteResult {
  value: unknown;
  logs: LogEntry[];
}

export type ExecuteError =
  | { kind: "runtime"; code: number }
  | {
      kind: "parse";
      message: string;
      line?: number;
      column?: number;
      snippet?: string;
    }
  | { kind: "exception"; message: string };

/** Convert snake_case to camelCase */
export function snakeToCamel(name: string): string {
  return name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/** Build a map of prefixed tool names → backend tool call functions */
function buildToolRegistry(backends: Map<string, Backend>): Map<string, ToolFunction> {
  const registry = new Map<string, ToolFunction>();

  for (const [name, backend] of backends) {
    for (const tool of backend.tools) {
      const prefixed = `${name}_${sanitizeName(tool.name)}`;
      registry.set(prefixed, async (args) => {
        return backend.client.callTool({
          name: tool.name,
          arguments: args,
        });
      });
    }
  }

  return registry;
}

/** Build a map of backend name → tool names (for namespace generation) */
function buildBackendToolMap(backends: Map<string, Backend>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [name, backend] of backends) {
    map.set(
      name,
      backend.tools.map((t) => t.name),
    );
  }
  return map;
}

/**
 * Generate code bindings: flat aliases + namespace proxies + console capture.
 */
function wrapCodeWithBindings(
  code: string,
  toolNames: string[],
  backendTools: Map<string, string[]>,
): string {
  // Console capture
  const consoleOverride = `
const __consoleLogs = [];
const console = {
  log: (...args) => __consoleLogs.push({ level: "log", args }),
  warn: (...args) => __consoleLogs.push({ level: "warn", args }),
  error: (...args) => __consoleLogs.push({ level: "error", args }),
  info: (...args) => __consoleLogs.push({ level: "info", args }),
  debug: (...args) => __consoleLogs.push({ level: "debug", args }),
};`;

  // Namespace proxies — grafana.searchDashboards() style
  const namespaces: string[] = [];
  for (const [backendName, tools] of backendTools) {
    const methods = tools
      .map((toolName) => {
        const camelName = snakeToCamel(sanitizeName(toolName));
        const prefixed = `${backendName}_${sanitizeName(toolName)}`;
        return `  ${camelName}: (args) => SecureExec.bindings.callTool("${prefixed}", args || {})`;
      })
      .join(",\n");
    namespaces.push(`const ${backendName} = {\n${methods}\n};`);
  }

  return `
${consoleOverride}
${namespaces.join("\n")}

const __userResult = await (async () => { ${code} })();
export default { value: __userResult, logs: __consoleLogs };
`;
}

/** Execute LLM-generated code in a V8 isolate with access to backend MCP tools */
export async function executeCode(
  code: string,
  backends: Map<string, Backend>,
  opts?: { memoryLimit?: number; cpuTimeLimitMs?: number },
): Promise<Result<ExecuteResult, ExecuteError>> {
  const registry = buildToolRegistry(backends);
  const backendTools = buildBackendToolMap(backends);

  const callTool: BindingFunction = async (name: unknown, args: unknown) => {
    const toolName = name as string;
    const toolArgs = (args as Record<string, unknown>) ?? {};
    const fn = registry.get(toolName);
    if (!fn) {
      return { error: `Unknown tool: ${toolName}` };
    }
    try {
      return await fn(toolArgs);
    } catch (e) {
      return { error: (e as Error).message };
    }
  };

  const wrappedCode = wrapCodeWithBindings(code, [...registry.keys()], backendTools);

  // AST validation — catch syntax errors with better messages before V8 execution
  const syntaxError = validateSyntax(wrappedCode);
  if (syntaxError) {
    return err({
      kind: "parse",
      message: syntaxError.message,
      line: syntaxError.line,
      column: syntaxError.column,
      snippet: syntaxError.snippet,
    });
  }

  const systemDriver = createNodeDriver({
    permissions: {
      fs: () => ({ allow: false }),
      network: () => ({ allow: false }),
      childProcess: () => ({ allow: false }),
      env: () => ({ allow: false }),
    },
  });

  const driver = new NodeExecutionDriver({
    system: systemDriver,
    runtime: {
      process: { cwd: "/root", env: {} },
      os: { homedir: "/root", tmpdir: "/tmp" },
    },
    memoryLimit: opts?.memoryLimit ?? 64,
    cpuTimeLimitMs: opts?.cpuTimeLimitMs ?? 30_000,
    bindings: { callTool },
  });

  try {
    const runResult = await driver.run(wrappedCode, "/entry.mjs");

    if (runResult.code !== 0) {
      return err({ kind: "runtime", code: runResult.code });
    }

    const exports = runResult.exports as Record<string, unknown>;
    const result = exports?.default as {
      value: unknown;
      logs: LogEntry[];
    } | null;
    return ok({
      value: result?.value ?? null,
      logs: result?.logs ?? [],
    });
  } catch (e) {
    return err({ kind: "exception", message: (e as Error).message });
  } finally {
    driver.dispose();
  }
}

export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}
