# mcpx

Self-hosted MCP Code Mode gateway.

## Commands

- `bun run dev` — development server with hot reload
- `bun run lint` — oxlint
- `bun run format` — biome format
- `bun run check` — lint + format check
- `bun test` — run tests
- `bun run build` — production build

## Architecture

4 source files in src/:

- index.ts — HTTP server (Hono) + stdio router
- config.ts — JSON config with ${VAR} interpolation
- backends.ts — MCP client connections via stdio subprocesses
- executor.ts — V8 isolate code execution via secure-exec

## Conventions

- Factory functions, no classes (except NodeRuntime from secure-exec)
- Biome for formatting, oxlint for linting
- Tests colocated: foo.test.ts next to foo.ts
