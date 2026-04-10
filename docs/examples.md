# Examples

Real-world `mcpx.json` configurations.

## Grafana (observability)

Query dashboards, search logs (Loki), find traces (Tempo), and run PromQL.

```json
{
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

Requires [mcp-grafana](https://github.com/grafana/mcp-grafana) and a Grafana service account with Editor role.

## GitHub

Search repos, manage issues and PRs.

```json
{
  "backends": {
    "github": {
      "transport": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
        "-e", "GITHUB_TOOLSETS",
        "ghcr.io/github/github-mcp-server"
      ],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}",
        "GITHUB_TOOLSETS": "context,repos,issues,pull_requests"
      }
    }
  }
}
```

## Multi-backend

Combine multiple servers behind one mcpx instance.

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
    },
    "github": {
      "transport": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
        "-e", "GITHUB_TOOLSETS",
        "ghcr.io/github/github-mcp-server"
      ],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}",
        "GITHUB_TOOLSETS": "context,repos,issues,pull_requests"
      }
    },
    "plane": {
      "transport": "stdio",
      "command": "uvx",
      "args": ["plane-mcp-server", "stdio"],
      "env": {
        "PLANE_API_KEY": "${PLANE_API_KEY}",
        "PLANE_WORKSPACE_SLUG": "${PLANE_WORKSPACE_SLUG}",
        "PLANE_BASE_URL": "${PLANE_BASE_URL}"
      }
    }
  }
}
```

## Local dev with docker-compose

If your project already runs services via docker-compose (e.g., Grafana LGTM for local observability), mcpx can connect to them:

```json
{
  "backends": {
    "grafana": {
      "transport": "stdio",
      "command": "uvx",
      "args": ["mcp-grafana"],
      "env": {
        "GRAFANA_URL": "http://localhost:3333",
        "GRAFANA_SERVICE_ACCOUNT_TOKEN": "${GRAFANA_TOKEN}"
      }
    }
  }
}
```

Add mcpx to your project's `.mcp.json` so every developer gets the same setup:

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

## Multi-environment

For projects with local, staging, and production environments, use separate configs:

```
mcpx.json              # local dev (stdio, localhost backends)
mcpx.staging.json      # staging (stdio or http, staging backends)
mcpx.prod.json         # production (http, prod backends)
```

Connect to a specific environment:

```bash
# Local
bunx mcpx-tools stdio mcpx.json

# Staging
bunx mcpx-tools stdio mcpx.staging.json
```

Or use HTTP for remote environments:

```json
{
  "mcpServers": {
    "mcpx-local": {
      "command": "bunx",
      "args": ["mcpx-tools", "stdio", "mcpx.json"]
    },
    "mcpx-staging": {
      "type": "http",
      "url": "https://mcp-staging.yourcompany.com/mcp",
      "headers": { "Authorization": "Bearer ${MCPX_STAGING_TOKEN}" }
    }
  }
}
```
