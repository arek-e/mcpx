import { NodeRuntime, createNodeDriver, createNodeRuntimeDriverFactory } from 'secure-exec';
import type { Backend } from './backends.js';

interface ExecuteResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

/** Execute LLM-generated code in a V8 isolate with access to backend MCP tools */
export async function executeCode(
  code: string,
  backends: Map<string, Backend>,
  opts?: { memoryLimit?: number; cpuTimeLimitMs?: number },
): Promise<ExecuteResult> {
  // Build the tool registry — maps prefixed names to backend tool calls
  const toolFunctions: Record<string, (args: unknown) => Promise<unknown>> = {};

  for (const [name, backend] of backends) {
    for (const tool of backend.tools) {
      const prefixedName = `${name}_${sanitizeName(tool.name)}`;
      toolFunctions[prefixedName] = async (args: unknown) => {
        const result = await backend.client.callTool({
          name: tool.name,
          arguments: args as Record<string, unknown>,
        });
        return result;
      };
    }
  }

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
    // V8 isolate can't call out to the host mid-execution.
    // Strategy: code accumulates tool calls synchronously, returns them,
    // then we execute calls on the host and return results.
    const toolNames = Object.keys(toolFunctions);

    const wrappedCode = `
const __calls = [];
${toolNames.map((n) => `const ${n} = (args) => { const i = __calls.length; __calls.push({ name: "${n}", args: args || {} }); return { __pending: i }; };`).join('\n')}

const __userResult = await (async () => { ${code} })();
export default { result: __userResult, calls: __calls };
`;

    const runResult = await runtime.run(wrappedCode, '/entry.mjs');

    if (runResult.code !== 0) {
      return {
        success: false,
        error: `Execution failed with code ${runResult.code}`,
      };
    }

    const output = (runResult.exports as Record<string, unknown>)?.default as
      | { result: unknown; calls: Array<{ name: string; args: unknown }> }
      | undefined;

    if (!output) {
      return { success: true, result: null };
    }

    // Execute accumulated tool calls on the host
    if (output.calls && output.calls.length > 0) {
      const results: unknown[] = [];
      for (const call of output.calls) {
        const fn = toolFunctions[call.name];
        if (!fn) {
          results.push({ error: `Unknown tool: ${call.name}` });
          continue;
        }
        try {
          results.push(await fn(call.args));
        } catch (err) {
          results.push({ error: (err as Error).message });
        }
      }
      return { success: true, result: results.length === 1 ? results[0] : results };
    }

    return { success: true, result: output.result };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  } finally {
    runtime.dispose();
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}
