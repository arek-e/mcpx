# Agent setup

mcpx works with any MCP-compatible agent via stdio or HTTP.

## Stdio (local)

The agent spawns mcpx as a subprocess. No server needed.

### Claude Code

```bash
claude mcp add mcpx -- bunx mcpx-tools stdio mcpx.json
```

Or add to `.mcp.json` (checked into git so your team shares the config):

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

### Cursor

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

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.mcpx]
command = "bunx"
args = ["mcpx-tools", "stdio", "mcpx.json"]
```

### Amp / OpenCode

Point your agent's MCP config at:

```bash
bunx mcpx-tools stdio mcpx.json
```

## HTTP (remote)

The agent connects to a running mcpx server over the network. See [deployment](deployment.md) first.

### Claude Code

```bash
claude mcp add-json mcpx '{"type":"http","url":"https://mcp.yourcompany.com/mcp","headers":{"Authorization":"Bearer TOKEN"}}'
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

### Cursor

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

### Codex

```toml
[mcp_servers.mcpx]
url = "https://mcp.yourcompany.com/mcp"
bearer_token_env_var = "MCPX_AUTH_TOKEN"
```
