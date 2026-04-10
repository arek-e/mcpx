# mcpx

![CI](https://github.com/arek-e/mcpx/actions/workflows/ci.yml/badge.svg)

Collapse multiple MCP servers into **2 tools**: `search` and `execute`.

```
Without mcpx:  agent ← 120 tool schemas (~84,000 tokens)
With mcpx:     agent ← 2 tools (~1,000 tokens)
```

## Quick start

```bash
bunx mcpx-tools init                                        # create mcpx.json
claude mcp add mcpx -- bunx mcpx-tools stdio mcpx.json      # connect agent
```

## Docs

- [Configuration](docs/configuration.md) — `mcpx.json` format, env vars, backends
- [Agent setup](docs/agents.md) — Claude Code, Cursor, Codex, Amp, OpenCode
- [Team deployment](docs/deployment.md) — Docker, Helm, standalone HTTP
- [Security](docs/security.md) — V8 sandbox, permissions, credential isolation
- [Examples](docs/examples.md) — Grafana, GitHub, multi-backend configs

## How it works

Your agent calls `search` to find tools, then `execute` to run JavaScript that calls them. Code runs in a sandboxed V8 isolate — no filesystem, no network, no env access. Tool calls are the only way out.

## License

Apache-2.0
