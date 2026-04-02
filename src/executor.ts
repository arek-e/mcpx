import { createNodeRuntime, createNodeDriver, type NodeRuntimeOptions } from 'secure-exec';
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
  const allowedHosts = new Set<string>();

  // Build the tool registry that the code can call
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

  // Wrap the user code with the tool registry injected as global functions
  const toolNames = Object.keys(toolFunctions);
  const wrappedCode = `
    export default async function() {
      ${toolNames.map((n) => `const ${n} = async (args) => __callTool("${n}", args);`).join('\n      ')}

      // User code
      ${code}
    }
  `;

  // Track pending tool calls from the isolate
  let pendingResolve: ((value: unknown) => void) | null = null;
  let pendingReject: ((reason: unknown) => void) | null = null;

  const driver = createNodeDriver({
    permissions: {
      fs: () => ({ allow: false }),
      network: () => ({ allow: false }),
      childProcess: () => ({ allow: false }),
      env: () => ({ allow: false }),
    },
  });

  const runtimeOpts: NodeRuntimeOptions = {
    systemDriver: driver,
    runtimeDriverFactory: driver,
    memoryLimit: opts?.memoryLimit ?? 64,
    cpuTimeLimitMs: opts?.cpuTimeLimitMs ?? 10_000,
  };

  const runtime = new createNodeRuntime(runtimeOpts);

  try {
    // Inject __callTool as a global binding
    const ctx = await runtime.__unsafeCreateContext();

    const result = await runtime.run(
      `
      const __toolCallQueue = [];
      globalThis.__callTool = async (name, args) => {
        // Since we can't call out from the isolate directly,
        // we accumulate tool calls and return them as part of the result
        __toolCallQueue.push({ name, args });
        return { _pending: true, _index: __toolCallQueue.length - 1 };
      };

      const userFn = (${wrappedCode.trim().replace(/^export default /, '')});
      const result = await userFn();
      ({ result, toolCalls: __toolCallQueue });
    `,
      '/entry.mjs',
    );

    // Process any tool calls made by the code
    if (
      result.returnValue &&
      typeof result.returnValue === 'object' &&
      'toolCalls' in (result.returnValue as Record<string, unknown>)
    ) {
      const rv = result.returnValue as {
        result: unknown;
        toolCalls: Array<{ name: string; args: unknown }>;
      };

      if (rv.toolCalls.length > 0) {
        // Execute tool calls sequentially and re-run with results
        const toolResults: unknown[] = [];
        for (const call of rv.toolCalls) {
          const fn = toolFunctions[call.name];
          if (!fn) {
            toolResults.push({
              error: `Unknown tool: ${call.name}`,
            });
            continue;
          }
          try {
            const r = await fn(call.args);
            toolResults.push(r);
          } catch (err) {
            toolResults.push({
              error: (err as Error).message,
            });
          }
        }

        return { success: true, result: toolResults };
      }

      return { success: true, result: rv.result };
    }

    return { success: true, result: result.returnValue };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  } finally {
    runtime.dispose();
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}
