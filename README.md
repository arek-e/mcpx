# mcpx

![CI](https://github.com/arek-e/mcpx/actions/workflows/ci.yml/badge.svg)

Self-hosted MCP Code Mode gateway. Aggregate multiple MCP servers behind **2 tools** with V8 isolate execution.

Instead of exposing 100+ tools to your LLM (eating context tokens), mcpx exposes **`search`** and **`execute`**. The LLM discovers tools via search, then writes JavaScript code that calls them. Code runs in a secure V8 isolate via [secure-exec](https://github.com/nicholasgasior/secure-exec).

```
Claude Code → mcpx (2 tools, ~1,000 tokens)
                  ↓
              search("grafana dashboards")
              → returns type definitions + params
                  ↓
              execute("const r = await grafana_search_dashboards({ query: 'pods' }); return r;")
              → runs in V8 isolate → calls Grafana MCP → returns result
```

## Why

| Approach                     | Context tokens |
| ---------------------------- | -------------- |
| 120 tools (full schemas)     | ~84,000        |
| 120 tools (minimal schemas)  | ~17,000        |
| **mcpx Code Mode (2 tools)** | **~1,000**     |

Inspired by [Cloudflare's Code Mode pattern](https://github.com/cloudflare/agents/tree/main/packages/codemode) — self-hosted, no Cloudflare dependency.

## Quick start

```bash
# Install
bun install

# Configure backends
cp mcpx.example.json mcpx.json
# Edit mcpx.json with your MCP server configs

# Run
bun run dev
```

## Configuration

`mcpx.json`:

```json
{
  "port": 3100,
  "authToken": "${MCPX_AUTH_TOKEN}",
  "backends": {
    "grafana": {
      "transport": "stdio",
      "command": "uvx",
      "args": ["mcp-grafana"],
      "env": {
        "GRAFANA_URL": "${GRAFANA_URL}",
        "GRAFANA_SERVICE_ACCOUNT_TOKEN": "${GRAFANA_TOKEN}"
      }
    }
  }
}
```

Environment variables in `${VAR}` syntax are interpolated from `process.env`.

## Local / Solo Dev

No server required. Run mcpx as a stdio subprocess directly in Claude Code — no Kubernetes, no Docker, no port.

```bash
# Install once
bun add -g mcpx
# or: npx mcpx, bunx mcpx (no install needed)

# Run with your config
mcpx stdio mcpx.json
```

All output goes to stderr; stdout is reserved for the MCP protocol.

## Claude Code Plugin

Add mcpx to any project via `.mcp.json` (checked into git — teammates get it automatically):

```json
{
  "mcpServers": {
    "mcpx": {
      "command": "bunx",
      "args": ["mcpx", "stdio", "mcpx.json"],
      "env": {
        "GRAFANA_URL": "http://localhost:3000",
        "GRAFANA_TOKEN": "your-token"
      }
    }
  }
}
```

Copy `.mcp.json.example` as a starting point:

```bash
cp .mcp.json.example .mcp.json
# Edit .mcp.json with your credentials
```

## Connect to Claude Code (HTTP / team mode)

```bash
claude mcp add --transport http mcpx http://localhost:3100/mcp
```

Or in `.mcp.json` (per-project, checked into git):

```json
{
  "mcpServers": {
    "mcpx": {
      "type": "http",
      "url": "https://mcp.yourcompany.com/mcp",
      "headers": {
        "Authorization": "Bearer ${MCPX_AUTH_TOKEN}"
      }
    }
  }
}
```

## Deploy on Kubernetes

```bash
helm install mcpx ./helm/mcpx \
  --namespace mcpx --create-namespace \
  --set existingSecret=mcpx-secrets \
  --set ingress.enabled=true \
  --set ingress.host=mcp.yourcompany.com
```

## How it works

1. **On startup**: mcpx connects to all configured backend MCP servers (via stdio subprocesses or HTTP)
2. **Tool discovery**: collects all tools from all backends, generates TypeScript type definitions
3. **Exposes 2 tools** via MCP Streamable HTTP:
   - `search` — fuzzy search across all backend tools, returns matching type definitions + params
   - `execute` — runs JavaScript in a V8 isolate with access to all backend tools as async functions
4. **Execution**: code runs in [secure-exec](https://github.com/nicholasgasior/secure-exec) with deny-by-default permissions (no fs, no network, no child process). Tool calls are intercepted and routed to the real backend MCP servers.

## Architecture

```
┌─────────────────────────────────────────┐
│ mcpx pod                                │
│                                         │
│  Hono HTTP server                       │
│  ├── GET  /health                       │
│  └── ALL  /mcp (MCP Streamable HTTP)   │
│       ├── search → schema lookup        │
│       └── execute → secure-exec V8      │
│            ↓                            │
│       V8 isolate (3.4MB, 16ms boot)     │
│       deny-by-default permissions       │
│            ↓                            │
│       routes tool calls to backends:    │
│       ├── grafana (stdio subprocess)    │
│       ├── plane (stdio subprocess)      │
│       └── github (stdio subprocess)    │
└─────────────────────────────────────────┘
```

## Security

- Code runs in V8 isolates (same isolation as Chromium browser tabs)
- Deny-by-default: no filesystem, no network, no child process, no env access
- Tool calls are the only way code can interact with the outside world
- Each execution gets a fresh isolate (destroyed after completion)
- Backend credentials never enter the isolate — injected by the gateway process

## Stack

- [Bun](https://bun.sh) — runtime
- [Hono](https://hono.dev) — HTTP framework (14KB)
- [secure-exec](https://github.com/nicholasgasior/secure-exec) — V8 isolate sandbox
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) — MCP protocol
- Tree-shaken build: `bun build --minify` produces a single optimized file

## License

Apache-2.0
