#!/usr/bin/env bun
import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { z } from "zod";

import {
	createAuthVerifier,
	filterBackendsByClaims,
	type AuthClaims,
} from "./auth.js";
import {
	connectBackends,
	generateTypeDefinitions,
	generateToolListing,
	refreshAllTools,
	type Backend,
} from "./backends.js";
import { loadConfig } from "./config.js";
import { executeCode } from "./executor.js";
import { createOAuthRoutes } from "./oauth.js";
import {
	loadSkills,
	registerSkill,
	searchSkills,
	recordExecution,
	watchSkills,
	generateSkillTypeDefs,
} from "./skills.js";
import { startStdioServer } from "./stdio.js";
import { watchConfig } from "./watcher.js";

// Module-level vars for Bun.serve export default compat
let _exportPort = 0;
let _exportFetch: (req: Request) => Response | Promise<Response> = () =>
	new Response("stdio mode");

// Resolve version from package.json at startup
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
	readFileSync(join(__dirname, "../package.json"), "utf-8"),
) as {
	version: string;
};
const VERSION = pkg.version;

const command = process.argv[2];

// mcpx init [backend...]
if (command === "init") {
	const { runInit } = await import("./init.js");
	runInit(process.argv.slice(3));
	process.exit(0);
}

// mcpx stdio mcpx.json
if (command === "stdio") {
	const configPath = process.argv[3] ?? "mcpx.json";
	await startStdioServer(configPath);
	// Intentional: no process.exit() — StdioServerTransport keeps the event loop alive.
}

// HTTP server mode (default)
if (command !== "stdio") {
	const configPath = process.argv[2] ?? "mcpx.json";

	let config;
	try {
		config = loadConfig(configPath);
	} catch (err) {
		const msg =
			(err as NodeJS.ErrnoException).code === "ENOENT"
				? `Config file not found: ${configPath}\n  Create it or pass the path as an argument: mcpx <config.json>`
				: `Failed to load config from ${configPath}: ${(err as Error).message}`;
		console.error(`mcpx startup error: ${msg}`);
		process.exit(1);
	}

	console.log("mcpx starting...");
	console.log(`  version: ${VERSION}`);
	console.log(`  config: ${configPath}`);
	console.log(`  port: ${config.port}`);
	console.log(`  backends: ${Object.keys(config.backends).join(", ")}`);

	// Data directory — use config dir if writable, else /tmp
	const configDir = configPath.replace(/[^/]+$/, "");
	let dataDir: string;
	try {
		const testDir = join(configDir, ".mcpx");
		mkdirSync(testDir, { recursive: true });
		dataDir = testDir;
	} catch {
		dataDir = join("/tmp", ".mcpx");
		mkdirSync(dataDir, { recursive: true });
	}

	// Connect to all backend MCP servers
	console.log("\nConnecting to backends:");
	let backends: Map<string, import("./backends.js").Backend>;
	try {
		const tokensDir = join(dataDir, "tokens");
		backends = await connectBackends(config.backends, { tokensDir });
	} catch (err) {
		console.error(`Failed to connect backends: ${(err as Error).message}`);
		process.exit(1);
	}

	if (backends.size === 0 && !config.failOpen) {
		console.error(
			"No backends connected. Check that your backend commands are installed and accessible.\n  Use failOpen: true in config to start anyway.",
		);
		process.exit(1);
	}

	if (backends.size === 0) {
		console.warn(
			"Warning: no backends connected (failOpen mode — server will start degraded)",
		);
	}

	// Load skills from .mcpx/skills/
	const skillsDir = join(dataDir, "skills");
	const skills = loadSkills(skillsDir);
	if (skills.size > 0)
		console.log(`  ${skills.size} skills loaded from ${skillsDir}`);
	watchSkills(skillsDir, skills, () => {
		console.log(`Skills reloaded (${skills.size} skills)`);
	});

	// Pre-generate type definitions and tool listing (mutable for hot-reload + tool refresh)
	let typeDefs = generateTypeDefinitions(backends);
	let skillTypeDefs = generateSkillTypeDefs(skills);
	let toolListing = generateToolListing(backends);

	let totalTools = Array.from(backends.values()).reduce(
		(sum, b) => sum + b.tools.length,
		0,
	);
	console.log(
		`\n${totalTools} tools from ${backends.size} backends → 2 Code Mode tools`,
	);

	// Periodic tool refresh
	if (config.toolRefreshInterval && config.toolRefreshInterval > 0) {
		setInterval(async () => {
			try {
				await refreshAllTools(backends);
				typeDefs = generateTypeDefinitions(backends);
				toolListing = generateToolListing(backends);
				totalTools = Array.from(backends.values()).reduce(
					(sum, b) => sum + b.tools.length,
					0,
				);
			} catch (err) {
				console.error("Tool refresh failed:", (err as Error).message);
			}
		}, config.toolRefreshInterval * 1000);
	}

	// Hot-reload: watch config file for changes
	watchConfig(configPath, backends, (newConfig, diff) => {
		config = newConfig;
		typeDefs = generateTypeDefinitions(backends);
		toolListing = generateToolListing(backends);
		totalTools = Array.from(backends.values()).reduce(
			(sum, b) => sum + b.tools.length,
			0,
		);
		console.log(
			`Config reloaded: +${diff.added.length} -${diff.removed.length} ~${diff.changed.length} (${totalTools} tools)`,
		);
	});

	// Create the MCP server with Code Mode tools + skill management
	function createMcpServer(visibleBackends: Map<string, Backend>): McpServer {
		const server = new McpServer({
			name: "mcpx",
			version: VERSION,
		});

		server.tool(
			"search",
			`Search available tools and skills. Returns type definitions for matched tools.

Available tools:
${toolListing}`,
			{
				query: z
					.string()
					.describe(
						"Search query — tool name, backend name, skill name, or keyword",
					),
			},
			async ({ query }) => {
				const q = query.toLowerCase();
				const matched: string[] = [];

				for (const [name, backend] of visibleBackends) {
					for (const tool of backend.tools) {
						const fullName = `${name}_${tool.name}`;
						const desc = tool.description?.toLowerCase() ?? "";
						if (
							fullName.toLowerCase().includes(q) ||
							desc.includes(q) ||
							name.toLowerCase().includes(q)
						) {
							const params = tool.inputSchema?.properties
								? JSON.stringify(tool.inputSchema.properties, null, 2)
								: "{}";
							matched.push(
								`### ${fullName}\n${tool.description ?? ""}\nParameters: ${params}`,
							);
						}
					}
				}

				// Also search skills
				const matchedSkills = searchSkills(skills, query);
				for (const s of matchedSkills) {
					matched.push(
						`### skill.${s.name} [${s.trust}]\n${s.description}\nCode: ${s.code.slice(0, 200)}${s.code.length > 200 ? "..." : ""}`,
					);
				}

				if (matched.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: `No tools or skills found matching "${query}".`,
							},
						],
					};
				}

				return {
					content: [
						{
							type: "text" as const,
							text: `Found ${matched.length} results:\n\n${matched.join("\n\n")}`,
						},
					],
				};
			},
		);

		server.tool(
			"execute",
			`Execute JavaScript code that calls MCP tools. The code runs in a V8 isolate.

Write an async function body. Available tool functions (call with await):
${typeDefs}
${skillTypeDefs}

Example:
  const result = await grafana.searchDashboards({ query: "pods" });
  return result;`,
			{
				code: z.string().describe("JavaScript async function body to execute"),
			},
			async ({ code }) => {
				const result = await executeCode(code, visibleBackends, { skills });

				if (result.isErr()) {
					const e = result.error;
					let msg =
						e.kind === "runtime"
							? `Execution failed with code ${e.code}`
							: e.message;
					if (e.kind === "parse" && e.snippet) msg += `\n\n${e.snippet}`;
					return {
						content: [{ type: "text" as const, text: `Error: ${msg}` }],
						isError: true,
					};
				}

				const val = result.value.value;
				const text =
					typeof val === "string" ? val : JSON.stringify(val, null, 2);
				const logText =
					result.value.logs.length > 0
						? `\n\n--- Console Output ---\n${result.value.logs.map((l) => `[${l.level}] ${l.args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`).join("\n")}`
						: "";
				const eventText =
					result.value.events.filter(
						(e) => e.type === "tool_call" || e.type === "tool_error",
					).length > 0
						? `\n\n--- Execution Events ---\n${result.value.events
								.filter((e) => e.type !== "console")
								.map(
									(e) =>
										`[${e.type}] ${e.tool ?? ""}${e.durationMs ? ` (${e.durationMs}ms)` : ""}${e.error ? ` ERROR: ${e.error}` : ""}`,
								)
								.join("\n")}`
						: "";

				return {
					content: [
						{ type: "text" as const, text: text + logText + eventText },
					],
				};
			},
		);

		server.tool(
			"register_skill",
			"Save working code as a reusable skill. The skill becomes available to all agents connected to this gateway.",
			{
				name: z.string().describe("Skill name (alphanumeric + hyphens)"),
				description: z.string().describe("What this skill does"),
				code: z
					.string()
					.describe("JavaScript async function body (same as execute code)"),
			},
			async ({ name, description, code: skillCode }) => {
				const skill = registerSkill(skillsDir, skills, {
					name,
					description,
					code: skillCode,
				});
				skillTypeDefs = generateSkillTypeDefs(skills);
				return {
					content: [
						{
							type: "text" as const,
							text: `Skill "${skill.name}" registered (${skill.trust}). Available as skill.${skill.name}() in execute.`,
						},
					],
				};
			},
		);

		return server;
	}

	// HTTP server with Hono
	const app = new Hono();

	// Record start time for uptime reporting
	const startedAt = Date.now();

	// Health check — includes uptime, version, and per-backend tool counts
	app.get("/health", (c) => {
		const backendDetails = Array.from(backends.entries()).map(
			([name, backend]) => ({
				name,
				tools: backend.tools.length,
			}),
		);

		return c.json({
			status: backends.size === 0 ? "degraded" : "ok",
			version: VERSION,
			uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
			backends: backendDetails,
			totalTools,
		});
	});

	// Mount OAuth routes if configured
	if (config.auth?.oauth) {
		createOAuthRoutes(config.auth.oauth, app);
	}

	// Auth middleware — JWT, bearer, OAuth, or open
	const verifier = createAuthVerifier(config);
	if (verifier) {
		app.use("/mcp", async (c, next) => {
			const authHeader = c.req.header("Authorization");
			const token = authHeader?.replace(/^Bearer\s+/i, "");
			if (!token) {
				// Per MCP OAuth spec — include metadata URL in 401 response
				const headers: Record<string, string> = {};
				if (config.auth?.oauth) {
					headers["WWW-Authenticate"] =
						`Bearer resource_metadata="/.well-known/oauth-authorization-server"`;
				}
				return c.json({ error: "unauthorized" }, { status: 401, headers });
			}

			const result = await verifier(token);
			if (result.isErr()) return c.json({ error: result.error }, 401);

			// Store claims for per-backend filtering
			c.set("claims" as never, result.value as never);
			await next();
		});
	}

	// Session management for stateful MCP connections
	const sessions = new Map<
		string,
		{
			server: McpServer;
			transport: WebStandardStreamableHTTPServerTransport;
			lastAccess: number;
		}
	>();
	const sessionTtlMs = (config.sessionTtlMinutes ?? 30) * 60 * 1000;

	// Expire stale sessions every minute
	setInterval(() => {
		const now = Date.now();
		for (const [id, session] of sessions) {
			if (now - session.lastAccess > sessionTtlMs) {
				sessions.delete(id);
			}
		}
	}, 60_000);

	// MCP endpoint — Streamable HTTP with session support
	app.all("/mcp", async (c) => {
		// Resolve visible backends based on auth claims
		const claims = c.get("claims" as never) as AuthClaims | undefined;
		const visibleBackends = claims
			? filterBackendsByClaims(backends, claims, config.backends)
			: backends;

		const sessionId = c.req.header("mcp-session-id");

		// Reuse existing session
		if (sessionId && sessions.has(sessionId)) {
			const session = sessions.get(sessionId)!;
			session.lastAccess = Date.now();
			const response = await session.transport.handleRequest(c.req.raw);
			return response;
		}

		// New session
		const server = createMcpServer(visibleBackends);
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: () => crypto.randomUUID(),
		});

		await server.connect(transport);

		// Store session after first response (which contains the session ID)
		const response = await transport.handleRequest(c.req.raw);

		const newSessionId = response.headers.get("mcp-session-id");
		if (newSessionId) {
			sessions.set(newSessionId, { server, transport, lastAccess: Date.now() });
		}

		return response;
	});

	// Graceful shutdown — disconnect all backend clients before exiting
	async function shutdown(signal: string): Promise<void> {
		console.log(`\nmcpx received ${signal}, shutting down...`);
		const disconnects = Array.from(backends.values()).map((b) =>
			b.client.close().catch((err: Error) => {
				console.error(
					`  failed to disconnect backend ${b.name}: ${err.message}`,
				);
			}),
		);
		await Promise.allSettled(disconnects);
		console.log("mcpx shutdown complete");
		process.exit(0);
	}

	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));

	console.log(`\nmcpx listening on http://localhost:${config.port}`);
	console.log(`  MCP endpoint: http://localhost:${config.port}/mcp`);
	console.log(`  Health: http://localhost:${config.port}/health`);

	// Bun.serve compat — export default must be at module level but
	// config/app are block-scoped, so we assign to module-level vars.
	_exportPort = config.port;
	_exportFetch = app.fetch;
}

export default {
	get port() {
		return _exportPort;
	},
	get fetch() {
		return _exportFetch;
	},
};
