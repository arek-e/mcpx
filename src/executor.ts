import { ok, err, type Result } from "neverthrow";
import { createNodeDriver, NodeExecutionDriver, type BindingFunction } from "secure-exec";

import { validateSyntax } from "./ast.js";
import type { Backend } from "./backends.js";
import type { Skill } from "./skills.js";

type ToolFunction = (args: Record<string, unknown>) => Promise<unknown>;

export interface LogEntry {
  level: "log" | "warn" | "error" | "info" | "debug";
  args: unknown[];
}

export interface ExecutionEvent {
  type:
    | "tool_call"
    | "tool_result"
    | "tool_error"
    | "console"
    | "execution_start"
    | "execution_end";
  timestamp: number;
  tool?: string;
  args?: unknown;
  result?: unknown;
  error?: string;
  durationMs?: number;
  level?: string;
  message?: string;
}

export interface ExecuteResult {
  value: unknown;
  logs: LogEntry[];
  events: ExecutionEvent[];
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
function buildToolRegistry(
  backends: Map<string, Backend>,
  skills: Map<string, Skill>,
  events: ExecutionEvent[],
): Map<string, ToolFunction> {
  const registry = new Map<string, ToolFunction>();

  // Backend tools
  for (const [name, backend] of backends) {
    for (const tool of backend.tools) {
      const prefixed = `${name}_${sanitizeName(tool.name)}`;
      registry.set(prefixed, async (args) => {
        const start = Date.now();
        events.push({
          type: "tool_call",
          timestamp: start,
          tool: prefixed,
          args,
        });
        try {
          const result = await backend.client.callTool({
            name: tool.name,
            arguments: args,
          });
          events.push({
            type: "tool_result",
            timestamp: Date.now(),
            tool: prefixed,
            result,
            durationMs: Date.now() - start,
          });
          return result;
        } catch (e) {
          const msg = (e as Error).message;
          events.push({
            type: "tool_error",
            timestamp: Date.now(),
            tool: prefixed,
            error: msg,
            durationMs: Date.now() - start,
          });
          return { error: msg };
        }
      });
    }
  }

  // Skill tools — execute saved code in the same sandbox context
  for (const [, skill] of skills) {
    const prefixed = `skill_${sanitizeName(skill.name)}`;
    registry.set(prefixed, async (args) => {
      const start = Date.now();
      events.push({
        type: "tool_call",
        timestamp: start,
        tool: prefixed,
        args,
      });
      try {
        // Skills run as inline functions — they have access to the same tool bindings
        const fn = new Function("args", `return (async () => { ${skill.code} })()`);
        const result = await fn(args);
        events.push({
          type: "tool_result",
          timestamp: Date.now(),
          tool: prefixed,
          result,
          durationMs: Date.now() - start,
        });
        return result;
      } catch (e) {
        const msg = (e as Error).message;
        events.push({
          type: "tool_error",
          timestamp: Date.now(),
          tool: prefixed,
          error: msg,
          durationMs: Date.now() - start,
        });
        return { error: msg };
      }
    });
  }

  return registry;
}

/** Build a map of backend name → tool names (for namespace generation) */
function buildBackendToolMap(
  backends: Map<string, Backend>,
  skills: Map<string, Skill>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [name, backend] of backends) {
    map.set(
      name,
      backend.tools.map((t) => t.name),
    );
  }

  // Skills get their own namespace
  if (skills.size > 0) {
    map.set(
      "skill",
      Array.from(skills.values()).map((s) => s.name),
    );
  }

  return map;
}

/** Generate namespace proxy code for the sandbox */
function wrapCodeWithBindings(code: string, backendTools: Map<string, string[]>): string {
  const consoleOverride = `
const __consoleLogs = [];
const console = {
  log: (...args) => __consoleLogs.push({ level: "log", args }),
  warn: (...args) => __consoleLogs.push({ level: "warn", args }),
  error: (...args) => __consoleLogs.push({ level: "error", args }),
  info: (...args) => __consoleLogs.push({ level: "info", args }),
  debug: (...args) => __consoleLogs.push({ level: "debug", args }),
};`;

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
  opts?: {
    memoryLimit?: number;
    cpuTimeLimitMs?: number;
    skills?: Map<string, Skill>;
  },
): Promise<Result<ExecuteResult, ExecuteError>> {
  const events: ExecutionEvent[] = [];
  const skills = opts?.skills ?? new Map();
  const registry = buildToolRegistry(backends, skills, events);
  const backendTools = buildBackendToolMap(backends, skills);

  events.push({ type: "execution_start", timestamp: Date.now() });

  const callTool: BindingFunction = async (name: unknown, args: unknown) => {
    const toolName = name as string;
    const toolArgs = (args as Record<string, unknown>) ?? {};
    const fn = registry.get(toolName);
    if (!fn) {
      return { error: `Unknown tool: ${toolName}` };
    }
    return fn(toolArgs);
  };

  const wrappedCode = wrapCodeWithBindings(code, backendTools);

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

    events.push({ type: "execution_end", timestamp: Date.now() });

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
      events,
    });
  } catch (e) {
    events.push({ type: "execution_end", timestamp: Date.now() });
    return err({ kind: "exception", message: (e as Error).message });
  } finally {
    driver.dispose();
  }
}

export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}
