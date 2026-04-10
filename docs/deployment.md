# Team deployment

Run mcpx as an HTTP server so your whole team shares one endpoint. Credentials stay on the server — developers never see API keys.

## Docker

```bash
docker compose up -d
```

The included `docker-compose.yml` builds from source and mounts `mcpx.json`:

```yaml
services:
  mcpx:
    build: .
    ports:
      - '3100:3100'
    volumes:
      - ./mcpx.json:/app/mcpx.json:ro
    environment:
      - MCPX_AUTH_TOKEN=your-token
```

Pass backend secrets via environment variables:

```yaml
    environment:
      - MCPX_AUTH_TOKEN=your-token
      - GRAFANA_URL=https://grafana.internal
      - GRAFANA_TOKEN=glsa_xxx
      - GITHUB_TOKEN=ghp_xxx
```

## Kubernetes (Helm)

```bash
helm install mcpx ./helm/mcpx \
  --namespace mcpx --create-namespace \
  --set existingSecret=mcpx-secrets \
  --set ingress.enabled=true \
  --set ingress.host=mcp.yourcompany.com
```

### Values

| Value | Default | Description |
|-------|---------|-------------|
| `replicaCount` | `1` | Pod replicas |
| `image.repository` | `ghcr.io/arek-e/mcpx` | Container image |
| `image.tag` | `latest` | Image tag |
| `service.port` | `3100` | Service port |
| `ingress.enabled` | `false` | Enable ingress |
| `ingress.host` | `mcp.example.com` | Ingress hostname |
| `ingress.tls.enabled` | `false` | Enable TLS |
| `existingSecret` | `""` | K8s secret with env vars |
| `config.backends` | `{}` | Inline backend config |

### Secrets

Create a K8s secret with your backend credentials:

```bash
kubectl create secret generic mcpx-secrets \
  --namespace mcpx \
  --from-literal=MCPX_AUTH_TOKEN=your-token \
  --from-literal=GRAFANA_URL=https://grafana.internal \
  --from-literal=GRAFANA_TOKEN=glsa_xxx
```

Reference it with `--set existingSecret=mcpx-secrets`.

## Standalone

```bash
bunx mcpx-tools mcpx.json
```

Starts an HTTP server on the configured port:

```
mcpx listening on http://localhost:3100
  MCP endpoint: http://localhost:3100/mcp
  Health: http://localhost:3100/health
```

## Health check

```bash
curl http://localhost:3100/health
```

Returns backend status, tool counts, and uptime:

```json
{
  "status": "ok",
  "version": "0.2.0",
  "uptimeSeconds": 3600,
  "backends": [
    { "name": "grafana", "tools": 42 },
    { "name": "github", "tools": 35 }
  ],
  "totalTools": 77
}
```

## RBAC

mcpx provides a single auth token. For per-team or per-user access control, put a gateway in front:

- [Pomerium](https://pomerium.com) — identity-aware proxy
- [agentgateway](https://agentgateway.dev) — MCP-native gateway with policies
