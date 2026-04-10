# Security

mcpx executes agent-written JavaScript in a sandboxed environment. The sandbox is the core security boundary.

## V8 isolate sandbox

Code runs in [secure-exec](https://github.com/rivet-dev/secure-exec), which provides V8 isolates — the same isolation technology used in Chromium browser tabs and Cloudflare Workers.

Each execution:

- Gets a **fresh isolate** (destroyed after completion)
- Boots in **~16ms** with **~3.4MB** memory overhead
- Has **no shared state** between executions

## Deny-by-default permissions

The isolate has no access to anything except the tool call functions injected by mcpx:

| Capability | Allowed |
|------------|---------|
| MCP tool calls | Yes (routed through mcpx) |
| Filesystem | No |
| Network | No |
| Child processes | No |
| Environment variables | No |
| Global state between runs | No |

Tool calls are the **only way** code can interact with external systems.

## Credential isolation

Backend credentials (API keys, tokens) are configured in `mcpx.json` and injected into backend subprocesses by the mcpx gateway process. They never enter the V8 isolate.

```
Agent code (V8 isolate)
  → calls grafana_search_dashboards({ query: "pods" })
  → mcpx intercepts the call
  → mcpx routes it to the Grafana backend subprocess (which has GRAFANA_TOKEN)
  → result returned to the isolate
```

The agent code cannot read, log, or exfiltrate backend credentials because they don't exist in its execution environment.

## HTTP auth

In team deployment mode, mcpx validates a bearer token on every request:

```
Authorization: Bearer <MCPX_AUTH_TOKEN>
```

Set `authToken` in `mcpx.json` or via the `MCPX_AUTH_TOKEN` environment variable. Requests without a valid token get a `401 Unauthorized` response.

For production, pair with a reverse proxy (nginx, Pomerium, Cloudflare Access) for TLS termination and additional auth layers.
