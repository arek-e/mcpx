import { NodeRuntime, createNodeDriver, createNodeRuntimeDriverFactory } from "secure-exec";
import { ok, err, type Result } from "neverthrow";
import type { Backend } from "./backends.js";

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

interface IsolateOutput {
  result: unknown;
  calls: ToolCall[];
}

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

/** Wrap user code with tool stubs that accumulate calls */
function wrapCode(code: string, toolNames: string[]): string {
  const stubs = toolNames
    .map(
      (n) =>
        `const ${n} = (args) => { const i = __calls.length; __calls.push({ name: "${n}", args: args || {} }); return { __pending: i }; };`,
    )
    .join("\n");

  return `
const __calls = [];
${stubs}

const __userResult = await (async () => { ${code} })();
export default { result: __userResult, calls: __calls };
`;
}

/** Execute accumulated tool calls on the host and return results */
async function executePendingCalls(
  calls: ToolCall[],
  registry: Map<string, ToolFunction>,
): Promise<unknown[]> {
  const results: unknown[] = [];

  for (const call of calls) {
    const fn = registry.get(call.name);
    if (!fn) {
      results.push({ error: `Unknown tool: ${call.name}` });
      continue;
    }
    try {
      results.push(await fn(call.args));
    } catch (e) {
      results.push({ error: (e as Error).message });
    }
  }

  return results;
}

/** Execute LLM-generated code in a V8 isolate with access to backend MCP tools */
export async function executeCode(
  code: string,
  backends: Map<string, Backend>,
  opts?: { memoryLimit?: number; cpuTimeLimitMs?: number },
): Promise<Result<unknown, ExecuteError>> {
  const registry = buildToolRegistry(backends);

  const systemDriver = createNodeDriver({
    permissions: {
      fs: () => ({ allow: false }),
      network: () => ({ allow: false }),
      childProcess: () => ({ allow: false }),
      env: () => ({ allow: false }),
    },
  });

  const runtimeDriverFactory = createNodeRuntimeDriverFactory({});

  const runtime = new NodeRuntime({
    systemDriver,
    runtimeDriverFactory,
    memoryLimit: opts?.memoryLimit ?? 64,
    cpuTimeLimitMs: opts?.cpuTimeLimitMs ?? 10_000,
  });

  try {
    const wrappedCode = wrapCode(code, [...registry.keys()]);
    const runResult = await runtime.run(wrappedCode, "/entry.mjs");

    if (runResult.code !== 0) {
      return err({ kind: "runtime", code: runResult.code });
    }

    const exports = runResult.exports as Record<string, unknown>;
    const output = exports?.default as IsolateOutput | undefined;

    if (!output) {
      return ok(null);
    }

    if (output.calls?.length > 0) {
      const results = await executePendingCalls(output.calls, registry);
      return ok(results.length === 1 ? results[0] : results);
    }

    return ok(output.result);
  } catch (e) {
    return err({ kind: "exception", message: (e as Error).message });
  } finally {
    runtime.dispose();
  }
}

export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}
