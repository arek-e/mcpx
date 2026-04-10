# Configuration

mcpx is configured via `mcpx.json` in your project root.

## Generate a config

```bash
# Import servers from your existing .mcp.json
bunx mcpx-tools init

# Or start with a blank template
bunx mcpx-tools init --empty
```

`init` scans `.mcp.json` and `~/.claude.json` for existing MCP servers and converts them to mcpx backends.

## Config format

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

## Fields

| Field | Required | Description |
|-------|----------|-------------|
| `port` | No | HTTP server port (default: `3100`). Ignored in stdio mode. |
| `authToken` | No | Bearer token for HTTP mode. Ignored in stdio mode. |
| `backends` | Yes | Map of backend name → backend config. |

## Backend config

Each backend connects to one MCP server.

### stdio (subprocess)

```json
{
  "transport": "stdio",
  "command": "uvx",
  "args": ["mcp-grafana"],
  "env": {
    "GRAFANA_URL": "${GRAFANA_URL}"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `transport` | Yes | `"stdio"` |
| `command` | Yes | Executable to spawn |
| `args` | No | Command arguments |
| `env` | No | Environment variables passed to the subprocess |

### HTTP (remote)

```json
{
  "transport": "http",
  "url": "https://remote-mcp-server.example.com/mcp"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `transport` | Yes | `"http"` |
| `url` | Yes | MCP Streamable HTTP endpoint |

## Environment variables

Values wrapped in `${VAR}` are interpolated from `process.env` at startup. This keeps secrets out of config files.

```json
{
  "env": {
    "API_KEY": "${MY_API_KEY}"
  }
}
```

Set the actual values in your shell, `.env`, or CI secrets.
