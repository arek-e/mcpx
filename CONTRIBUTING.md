# Contributing to mcpx

## Setup

```bash
git clone https://github.com/arek-e/mcpx
cd mcpx
bun install
```

## Development

```bash
# Create your config
cp mcpx.example.json mcpx.json
# Edit mcpx.json — add your MCP backends

# Run in dev mode (auto-reload)
bun run dev

# Test the health endpoint
curl http://localhost:3100/health

# Test MCP via curl (JSON-RPC)
curl -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}'
```

## Testing with Claude Code

```bash
# Add mcpx as a local MCP server
claude mcp add --transport http mcpx http://localhost:3100/mcp

# Start Claude Code — it will discover the search + execute tools
claude
```

## Docker

```bash
docker compose up --build
```

## Build

```bash
# Optimized single-file build
bun run build

# Run the built version
bun dist/server.js mcpx.json
```

## Project structure

```
src/
├── index.ts      — HTTP server + MCP endpoint (2 tools: search + execute)
├── config.ts     — JSON config loader with ${VAR} interpolation
├── backends.ts   — MCP client connections + type/listing generation
└── executor.ts   — secure-exec V8 isolate code execution
```

## Architecture

mcpx exposes 2 MCP tools instead of N:

1. **`search`** — LLM queries available tools by keyword, gets type definitions back
2. **`execute`** — LLM writes JS code that calls tool functions, runs in V8 isolate

The isolate has deny-by-default permissions. Tool calls are the only side effect —
they're intercepted inside the isolate and routed to real backend MCP servers by the
gateway process.
