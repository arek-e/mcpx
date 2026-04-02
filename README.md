# mcpx

![CI](https://github.com/arek-e/mcpx/actions/workflows/ci.yml/badge.svg)

Self-hosted MCP Code Mode gateway. Aggregate multiple MCP servers behind **2 tools** with V8 isolate execution.

Instead of exposing 100+ tools to your LLM (eating context tokens), mcpx exposes **`search`** and **`execute`**. The LLM discovers tools via search, then writes JavaScript code that calls them. Code runs in a secure V8 isolate via [secure-exec](https://github.com/rivet-dev/secure-exec).

```
Your agent → mcpx (2 tools, ~1,000 tokens)
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

## Works with

<table>
<tr>
<td align="center"><img src="https://cdn.simpleicons.org/anthropic/181818" width="24" height="24" alt="Claude"><br><b>Claude Code</b></td>
<td align="center"><img src="https://cdn.simpleicons.org/cursor/181818" width="24" height="24" alt="Cursor"><br><b>Cursor</b></td>
<td align="center"><b>Codex</b></td>
<td align="center"><img src="https://cdn.simpleicons.org/amp/181818" width="24" height="24" alt="Amp"><br><b>Amp</b></td>
<td align="center"><b>OpenCode</b></td>
</tr>
</table>

Supports **stdio** and **HTTP (Streamable HTTP)** — works with any MCP-compatible agent.

---

## Solo developer

Run mcpx locally as a stdio subprocess. No server, no Docker, no Kubernetes.

### 1. Create config

```bash
# Import your existing MCP servers from .mcp.json
bunx mcpx-tools init

# Or start with a blank template
bunx mcpx-tools init --empty
```

Edit `mcpx.json` to add your backends:

```json
{
  "port": 3100,
  "backends": {
    "my-server": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "some-mcp-server"],
      "env": { "API_KEY": "${MY_API_KEY}" }
    }
  }
}
```

### 2. Connect your agent

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add mcpx -- bunx mcpx-tools stdio mcpx.json
```

Or add to `.mcp.json` (checked into git):

```json
{
  "mcpServers": {
    "mcpx": {
      "command": "bunx",
      "args": ["mcpx-tools", "stdio", "mcpx.json"]
    }
  }
}
```

</details>

<details>
<summary><b>Cursor</b></summary>

Add to `~/.cursor/mcp.json` or `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "mcpx": {
      "command": "bunx",
      "args": ["mcpx-tools", "stdio", "mcpx.json"]
    }
  }
}
```

</details>

<details>
<summary><b>Codex</b></summary>

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.mcpx]
command = "bunx"
args = ["mcpx-tools", "stdio", "mcpx.json"]
```

</details>

<details>
<summary><b>Amp / OpenCode</b></summary>

Any agent that supports stdio MCP:

```bash
bunx mcpx-tools stdio mcpx.json
```

Point your agent's MCP config at this command.

</details>

---

## Team deployment

Run mcpx as an HTTP server — one endpoint for your whole team. Agents connect over the network. Deploy on Kubernetes, Docker, or a VPS.

### 1. Deploy

**Docker:**

```bash
docker compose up -d
```

**Kubernetes (Helm):**

```bash
helm install mcpx ./helm/mcpx \
  --namespace mcpx --create-namespace \
  --set existingSecret=mcpx-secrets \
  --set ingress.enabled=true \
  --set ingress.host=mcp.yourcompany.com
```

**Standalone:**

```bash
bunx mcpx-tools mcpx.json
# → http://localhost:3100/mcp
```

### 2. Connect your agent

All agents point at the same HTTP endpoint. Auth is handled by a bearer token.

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add-json mcpx '{"type":"http","url":"https://mcp.yourcompany.com/mcp","headers":{"Authorization":"Bearer YOUR_TOKEN"}}'
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "mcpx": {
      "type": "http",
      "url": "https://mcp.yourcompany.com/mcp",
      "headers": { "Authorization": "Bearer ${MCPX_AUTH_TOKEN}" }
    }
  }
}
```

</details>

<details>
<summary><b>Cursor</b></summary>

```json
{
  "mcpServers": {
    "mcpx": {
      "url": "https://mcp.yourcompany.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

</details>

<details>
<summary><b>Codex</b></summary>

```toml
[mcp_servers.mcpx]
url = "https://mcp.yourcompany.com/mcp"
bearer_token_env_var = "MCPX_AUTH_TOKEN"
```

</details>

<details>
<summary><b>Any agent (HTTP)</b></summary>

Point at `https://mcp.yourcompany.com/mcp` with header `Authorization: Bearer YOUR_TOKEN`.

</details>

### Team benefits

- **One config, all tools** — Grafana, Plane, GitHub, K8s behind one endpoint
- **Credentials stay on the server** — devs never see API keys
- **RBAC via gateway** — pair with [Pomerium](https://pomerium.com) or [agentgateway](https://agentgateway.dev) for per-team tool access
- **50 tools → 2 tools** — same context savings for every team member

---

## Configuration

`mcpx.json`:

```json
{
  "port": 3100,
  "authToken": "${MCPX_AUTH_TOKEN}",
  "backends": {
    "my-server": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "some-mcp-server"],
      "env": {
        "API_KEY": "${MY_API_KEY}"
      }
    }
  }
}
```

Environment variables in `${VAR}` syntax are interpolated from `process.env`.

## How it works

1. **On startup**: mcpx connects to all configured backend MCP servers (via stdio subprocesses or HTTP)
2. **Tool discovery**: collects all tools from all backends, generates TypeScript type definitions
3. **Exposes 2 tools** via MCP Streamable HTTP or stdio:
   - `search` — fuzzy search across all backend tools, returns matching type definitions + params
   - `execute` — runs JavaScript in a V8 isolate with access to all backend tools as functions
4. **Execution**: code runs in [secure-exec](https://github.com/rivet-dev/secure-exec) with deny-by-default permissions (no fs, no network, no child process). Tool calls are intercepted and routed to the real backend MCP servers.

## Architecture

```
┌─────────────────────────────────────────┐
│ mcpx                                    │
│                                         │
│  MCP server (stdio or HTTP)             │
│  ├── search → schema lookup             │
│  └── execute → secure-exec V8           │
│       ↓                                 │
│  V8 isolate (3.4MB, 16ms boot)          │
│  deny-by-default permissions            │
│       ↓                                 │
│  routes tool calls to backends:         │
│  ├── grafana (stdio subprocess)         │
│  ├── plane (stdio subprocess)           │
│  └── github (stdio subprocess)          │
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
- [secure-exec](https://github.com/rivet-dev/secure-exec) — V8 isolate sandbox
- [neverthrow](https://github.com/supermacro/neverthrow) — typed error handling
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) — MCP protocol

## License

Apache-2.0
