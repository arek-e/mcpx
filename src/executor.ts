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

  const runtimeDriverFactory = createNodeRuntimeDriverFactory({
    memoryLimit: opts?.memoryLimit ?? 64,
  });

  const runtime = new NodeRuntime({
    systemDriver,
    runtimeDriverFactory,
    memoryLimit: opts?.memoryLimit ?? 64,
    cpuTimeLimitMs: opts?.cpuTimeLimitMs ?? 10_000,
  });

  try {
    // The V8 isolate can't call out to the host mid-execution.
    // Strategy: the code accumulates tool call requests, returns them,
    // then we execute the calls on the host and return results.
    const toolNames = Object.keys(toolFunctions);

    const wrappedCode = `
      const __calls = [];
      ${toolNames.map((n) => `const ${n} = (args) => { const i = __calls.length; __calls.push({ name: "${n}", args }); return { __pending: i }; };`).join('\n')}

      const __userResult = await (async () => { ${code} })();
      JSON.stringify({ result: __userResult, calls: __calls });
    `;

    const runResult = await runtime.run<string>(wrappedCode, '/entry.mjs');

    if (runResult.exitCode !== 0) {
      return {
        success: false,
        error: runResult.stderr || `Exit code ${runResult.exitCode}`,
      };
    }

    // Parse the isolate output
    let parsed: { result: unknown; calls: Array<{ name: string; args: unknown }> };
    try {
      const output = runResult.returnValue ?? runResult.stdout;
      parsed = JSON.parse(typeof output === 'string' ? output : JSON.stringify(output));
    } catch {
      // No tool calls, just return whatever the isolate produced
      return { success: true, result: runResult.returnValue ?? runResult.stdout };
    }

    // Execute accumulated tool calls on the host
    if (parsed.calls && parsed.calls.length > 0) {
      const results: unknown[] = [];
      for (const call of parsed.calls) {
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

    return { success: true, result: parsed.result };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  } finally {
    runtime.dispose();
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}
