import { createNodeDriver, NodeExecutionDriver, type BindingFunction } from "secure-exec";
import { ok, err, type Result } from "neverthrow";
import type { Backend } from "./backends.js";

type ToolFunction = (args: Record<string, unknown>) => Promise<unknown>;

export type ExecuteError =
  | { kind: "runtime"; code: number }
  | { kind: "parse"; message: string }
  | { kind: "exception"; message: string };

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

/**
 * Create convenience aliases so LLM-generated code can call `grafana_search(args)`
 * instead of `SecureExec.bindings.callTool("grafana_search", args)`.
 */
function wrapCodeWithBindings(code: string, toolNames: string[]): string {
  const aliases = toolNames
    .map((n) => `const ${n} = (args) => SecureExec.bindings.callTool("${n}", args || {});`)
    .join("\n");

  return `
${aliases}

const __userResult = await (async () => { ${code} })();
export default __userResult;
`;
}

/** Execute LLM-generated code in a V8 isolate with access to backend MCP tools */
export async function executeCode(
  code: string,
  backends: Map<string, Backend>,
  opts?: { memoryLimit?: number; cpuTimeLimitMs?: number },
): Promise<Result<unknown, ExecuteError>> {
  const registry = buildToolRegistry(backends);

  // Single dispatcher binding — avoids the 64-leaf limit.
  // All tools are called via callTool(name, args).
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

  const systemDriver = createNodeDriver({
    permissions: {
      fs: () => ({ allow: false }),
      network: () => ({ allow: false }),
      childProcess: () => ({ allow: false }),
      env: () => ({ allow: false }),
    },
  });

  // Use NodeExecutionDriver directly to access bindings support.
  // The high-level NodeRuntime class doesn't expose bindings.
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
    const wrappedCode = wrapCodeWithBindings(code, [...registry.keys()]);
    const runResult = await driver.run(wrappedCode, "/entry.mjs");

    if (runResult.code !== 0) {
      return err({ kind: "runtime", code: runResult.code });
    }

    const exports = runResult.exports as Record<string, unknown>;
    return ok(exports?.default ?? null);
  } catch (e) {
    return err({ kind: "exception", message: (e as Error).message });
  } finally {
    driver.dispose();
  }
}

export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}
