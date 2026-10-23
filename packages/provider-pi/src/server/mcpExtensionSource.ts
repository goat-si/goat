/**
 * Do not import t3code modules from the string body. The Pi process resolves
 * `@earendil-works/pi-coding-agent` and `typebox` from the user's pi install.
 */
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import {
  canonicalToolName,
  legacyAgentSurfacePaths,
  resolveAgentSurfaceEntry,
} from "@goat/contracts/agentSurface/resolve";
import { GOAT_ORCHESTRATION_INSTRUCTIONS } from "@goat/provider-core/server/orchestrationInstructions";
import { GOAT_DEVELOPMENT_INSTRUCTIONS } from "@goat/provider-core/server/developmentInstructions";
import { COMPUTER_USE_INSTRUCTIONS } from "@goat/provider-core/server/runtimeInstructions";

export const PI_GOAT_MCP_EXTENSION_FILENAME = "pi-goat-mcp-extension.ts";

export const GOAT_MCP_URL_ENV = "GOAT_MCP_URL";
export const GOAT_MCP_BEARER_ENV = "GOAT_MCP_BEARER_TOKEN";
export const GOAT_PI_RUNTIME_MODE_ENV = "GOAT_PI_RUNTIME_MODE";
export const GOAT_PI_MCP_EXTENSION_PATH_ENV = "GOAT_PI_MCP_EXTENSION_PATH";
/** The managed Cua Driver's stdio MCP command, as JSON `{ command, args, env }`. */
export const GOAT_CUA_MCP_ENV = "GOAT_CUA_MCP";
/**
 * A file the adapter rewrites before every turn: `on` while the turn may use the driver this
 * process launched with, anything else (Plan, read-only, a changed driver) closes it for the turn.
 */
export const GOAT_CUA_GATE_ENV = "GOAT_CUA_GATE";

/**
 * Pi tools whose confirmations the bridge raises as file-change approvals.
 * Auto-accept edits skips them; the adapter keys the approval kind off them.
 */
export const PI_FILE_CHANGE_TOOLS = ["edit", "write"] as const;

/**
 * The tools/list `_meta` flag GOAT sets on each resident tool. It is Claude Code's own key for a
 * tool that must never be deferred, so one flag serves every harness that defers tools.
 */
export const ALWAYS_LOAD_META_KEY = "anthropic/alwaysLoad";

/**
 * Every path and name goat_call resolves to a read, by the resolver goat_call itself uses.
 * goat_call is annotated destructive so clients ask before it; a call naming a read runs as one.
 */
const GOAT_CALL_READ_TARGETS = [
  ...new Set([
    ...Object.values(agentSurfaceRegistry).flatMap((entry) => [
      entry.path,
      canonicalToolName(entry),
      entry.name,
      ...entry.legacyNames,
    ]),
    ...legacyAgentSurfacePaths.keys(),
  ]),
]
  .filter((name) => resolveAgentSurfaceEntry(name)?.effect === "read")
  .toSorted();

export const PI_GOAT_MCP_EXTENSION_SOURCE = `\
import { stripFrontmatter, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { ChildProcess } from "node:child_process";
import { Type } from "typebox";

const URL_ENV = ${JSON.stringify(GOAT_MCP_URL_ENV)};
const TOKEN_ENV = ${JSON.stringify(GOAT_MCP_BEARER_ENV)};
const RUNTIME_MODE_ENV = ${JSON.stringify(GOAT_PI_RUNTIME_MODE_ENV)};
const EXTENSION_PATH_ENV = ${JSON.stringify(GOAT_PI_MCP_EXTENSION_PATH_ENV)};
const CUA_ENV = ${JSON.stringify(GOAT_CUA_MCP_ENV)};
const CUA_GATE_ENV = ${JSON.stringify(GOAT_CUA_GATE_ENV)};
const ALWAYS_LOAD_META_KEY = ${JSON.stringify(ALWAYS_LOAD_META_KEY)};
const GOAT_CALL_READ_TARGETS = new Set(${JSON.stringify(GOAT_CALL_READ_TARGETS)});
const ORCHESTRATION_INSTRUCTIONS = ${JSON.stringify(GOAT_ORCHESTRATION_INSTRUCTIONS.trim())};
const DEVELOPMENT_INSTRUCTIONS = ${JSON.stringify(GOAT_DEVELOPMENT_INSTRUCTIONS)};
const COMPUTER_USE_INSTRUCTIONS = ${JSON.stringify(COMPUTER_USE_INSTRUCTIONS)};
const PROTOCOL = "2025-06-18";
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const FILE_CHANGE_TOOLS = new Set(${JSON.stringify(PI_FILE_CHANGE_TOOLS)});

type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type JsonRpcResponse = {
  readonly id?: number | string;
  readonly result?: JsonValue;
  readonly error?: { readonly message?: string };
};

type McpTool = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly annotations?: { readonly readOnlyHint?: boolean };
  readonly outputSchema?: Record<string, unknown>;
  readonly _meta?: Record<string, unknown>;
};

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function runtimeMode(): RuntimeMode {
  const value = env(RUNTIME_MODE_ENV);
  return value === "approval-required" ||
    value === "auto-accept-edits" ||
    value === "auto" ||
    value === "full-access"
    ? value
    : "full-access";
}

function toolInputSummary(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2).slice(0, 4_000);
  } catch {
    return String(input).slice(0, 4_000);
  }
}

function parseSseOrJson(body: string, contentType: string): JsonRpcResponse {
  if (contentType.includes("text/event-stream")) {
    for (const line of body.split("\\n")) {
      const trimmed = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (trimmed.length === 0) continue;
      const parsed = JSON.parse(trimmed) as JsonRpcResponse;
      if (parsed.id !== undefined || parsed.result !== undefined || parsed.error !== undefined) {
        return parsed;
      }
    }
    throw new Error("MCP SSE response had no JSON-RPC payload.");
  }
  return JSON.parse(body) as JsonRpcResponse;
}

function jsonSchemaToTypebox(schema: Record<string, unknown> | undefined) {
  const unsafe = (Type as { Unsafe?: (value: unknown) => unknown }).Unsafe;
  if (typeof unsafe === "function" && schema !== undefined) {
    // Zero-argument MCP tools may omit "properties", which some OpenAI-compatible
    // servers reject. Declare it, as Pi does for its own MCP tools.
    return unsafe({
      ...schema,
      type: schema.type ?? "object",
      ...(schema.properties === undefined ? { properties: {} } : {}),
    });
  }
  return Type.Object({}, { additionalProperties: true });
}

type ModelContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function mcpModelContent(result: unknown): ModelContent[] {
  if (result === null || result === undefined) return [];
  if (typeof result !== "object") return [{ type: "text", text: String(result) }];
  const record = result as {
    readonly content?: ReadonlyArray<{
      readonly type?: string;
      readonly text?: string;
      readonly data?: string;
      readonly mimeType?: string;
    }>;
    readonly structuredContent?: unknown;
  };
  const content: ModelContent[] = [];
  if (Array.isArray(record.content)) {
    for (const part of record.content) {
      if (part?.type === "text" && typeof part.text === "string") {
        content.push({ type: "text", text: part.text });
      } else if (part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
        content.push({ type: "image", data: part.data, mimeType: part.mimeType });
      }
    }
  }
  // Structured output belongs to scripts. Only use it as model text when
  // the server supplied no model-facing blocks, matching Pi's native MCP tools.
  if (content.length === 0) {
    content.push({ type: "text", text: JSON.stringify(record.structuredContent ?? result) });
  }
  return content;
}

function mcpScriptResult(result: JsonValue | undefined) {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return result;
  const { _meta: _ignored, ...scriptResult } = result;
  return scriptResult;
}

function mcpOutputSchema(tool: McpTool) {
  return jsonSchemaToTypebox({
    type: "object",
    properties: {
      content: { type: "array", items: { type: "object" } },
      ...(tool.outputSchema === undefined ? {} : { structuredContent: tool.outputSchema }),
      isError: { type: "boolean" },
      _meta: { type: "object" },
    },
    required: ["content"],
  });
}

function isMcpToolError(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "isError" in result &&
    result.isError === true
  );
}

function createMcpClient(endpoint: string, token: string) {
  let nextId = 1;
  let sessionId: string | undefined;

  const headers = (): Record<string, string> => {
    const next: Record<string, string> = {
      accept: "application/json, text/event-stream",
      authorization: token.startsWith("Bearer ") ? token : \`Bearer \${token}\`,
      "content-type": "application/json",
      // Effect's HTTP MCP rejects post-initialize requests without this
      // (400). The worktree client in McpHttpServer tests sends the same
      // header; initialize itself does not require it.
      "mcp-protocol-version": PROTOCOL,
    };
    if (sessionId !== undefined) next["mcp-session-id"] = sessionId;
    return next;
  };

  const request = async (method: string, params?: unknown, signal?: AbortSignal) => {
    const id = nextId++;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal,
    });
    const nextSession = response.headers.get("mcp-session-id");
    if (nextSession) sessionId = nextSession;
    const body = await response.text();
    if (!response.ok) {
      throw new Error(\`MCP \${method} failed (\${response.status}): \${body.slice(0, 400)}\`);
    }
    if (body.length === 0) return undefined;
    const parsed = parseSseOrJson(body, response.headers.get("content-type") ?? "");
    if (parsed.error) {
      throw new Error(parsed.error.message ?? \`MCP \${method} returned an error\`);
    }
    return parsed.result;
  };

  const notify = async (method: string, params?: unknown, signal?: AbortSignal) => {
    await fetch(endpoint, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      signal,
    });
  };

  return {
    async connect(signal?: AbortSignal) {
      await request(
        "initialize",
        {
          protocolVersion: PROTOCOL,
          capabilities: {},
          clientInfo: { name: "t3-pi-mcp", version: "1.0.0" },
        },
        signal,
      );
      await notify("notifications/initialized", {}, signal).catch(() => undefined);
    },
    async listTools(signal?: AbortSignal) {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      do {
        const result = (await request(
          "tools/list",
          cursor === undefined ? {} : { cursor },
          signal,
        )) as { tools?: McpTool[]; nextCursor?: string } | undefined;
        tools.push(...(result?.tools ?? []));
        cursor = result?.nextCursor;
      } while (cursor);
      return tools;
    },
    async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
      return request("tools/call", { name, arguments: args }, signal);
    },
  };
}

type StdioMcpSpec = { command: string; args: string[]; env: Record<string, string> };

/** A newline-delimited JSON-RPC client for a stdio MCP server, started on first use. */
function createStdioMcpClient(spec: StdioMcpSpec) {
  let nextId = 1;
  let child: ChildProcess | undefined;
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  const failAll = (error: Error) => {
    for (const pending of waiting.values()) pending.reject(error);
    waiting.clear();
  };
  const start = async () => {
    // Loaded on first use, so sessions without computer use never touch it.
    const { spawn } = await import("node:child_process");
    const current = spawn(spec.command, spec.args, {
      env: { ...process.env, ...spec.env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    child = current;
    let buffer = "";
    current.stdout?.setEncoding("utf8");
    current.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: JsonRpcResponse;
        try {
          message = JSON.parse(line) as JsonRpcResponse;
        } catch {
          continue;
        }
        const pending = typeof message.id === "number" ? waiting.get(message.id) : undefined;
        if (pending === undefined) continue;
        waiting.delete(message.id as number);
        if (message.error) pending.reject(new Error(message.error.message ?? "MCP error"));
        else pending.resolve(message.result);
      }
    });
    // Only the current driver's exit fails calls: a replaced one's late exit
    // must not fail the calls already waiting on its replacement.
    const stopped = () => {
      if (child !== current) return;
      child = undefined;
      failAll(new Error("Cua Driver stopped. Call the tool again to start a new session."));
    };
    current.on("exit", stopped);
    current.on("error", stopped);
  };
  const request = async (method: string, params?: unknown, signal?: AbortSignal) => {
    if (child === undefined) await start();
    return new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      signal?.addEventListener("abort", () => {
        if (waiting.delete(id)) reject(new Error("Aborted"));
      });
      child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n");
    });
  };
  const notify = (method: string, params?: unknown) => {
    child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\\n");
  };
  const connect = async (signal?: AbortSignal) => {
    await request(
      "initialize",
      { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "goat-pi-mcp", version: "1.0.0" } },
      signal,
    );
    notify("notifications/initialized", {});
  };

  return {
    connect,
    async listTools(signal?: AbortSignal) {
      const result = (await request("tools/list", {}, signal)) as { tools?: McpTool[] } | undefined;
      return result?.tools ?? [];
    },
    async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
      // A driver that exited (the session ended) starts again and needs a handshake.
      if (child === undefined) await connect(signal);
      return request("tools/call", { name, arguments: args }, signal);
    },
    close() {
      const current = child;
      child = undefined;
      current?.kill();
      failAll(new Error("Cua Driver stopped. Call the tool again to start a new session."));
    },
  };
}

// A process launched by an adapter without the gate keeps its launch-time behavior. Once the
// gate exists, anything but "on", including a missing or unreadable file, closes the driver.
async function readCuaGate(): Promise<boolean> {
  const path = env(CUA_GATE_ENV);
  if (path === undefined) return true;
  try {
    const { readFile } = await import("node:fs/promises");
    return (await readFile(path, "utf8")).trim() === "on";
  } catch {
    return false;
  }
}

function cuaSpec(): StdioMcpSpec | undefined {
  const raw = env(CUA_ENV);
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as { command?: unknown; args?: unknown; env?: unknown };
    if (typeof parsed.command !== "string" || !Array.isArray(parsed.args)) return undefined;
    return {
      command: parsed.command,
      args: parsed.args.map(String),
      env: (parsed.env ?? {}) as Record<string, string>,
    };
  } catch {
    return undefined;
  }
}

export default async function goatMcpExtension(pi: ExtensionAPI) {
  // Keep skill chips in the request. Pi expands only one leading /skill:
  // command, so use its own frontmatter loader for every selected chip here.
  pi.on("input", async (event, ctx) => {
    if (!event.text.includes("$")) return;
    const commands = pi.getCommands().filter((command) => command.source === "skill");
    const nativeSkill = /^\\/skill:([^ ]+)(?: |$)/.exec(event.text)?.[1];
    const seen = new Set<string>(nativeSkill === undefined ? [] : [nativeSkill]);
    const blocks: string[] = [];
    for (const match of event.text.matchAll(/(^|\\s)\\$([^\\s]+)(?=\\s|$)/g)) {
      const name = match[2];
      if (name === undefined || seen.has(name)) continue;
      const command = commands.find((candidate) => candidate.name === "skill:" + name);
      if (command === undefined) continue;
      seen.add(name);
      const path = command.sourceInfo.path;
      try {
        const body = stripFrontmatter(await NodeFSP.readFile(path, "utf8")).trim();
        blocks.push(
          \`<skill name="\${name}" location="\${path}">\\nReferences are relative to \${NodePath.dirname(path)}.\\n\\n\${body}\\n</skill>\`,
        );
      } catch {
        ctx.ui.notify(\`Could not load skill \${name} from \${path}.\`, "error");
      }
    }
    if (blocks.length === 0) return;
    return {
      action: "transform",
      text: event.text + "\\n\\n" + blocks.join("\\n\\n"),
      images: event.images,
    };
  });

  // Workaround for an upstream Pi context-budgeting bug: pi-ai reuses the
  // previous response's usage even when a fork's instructions/tools differ,
  // then reserves almost all remaining context for output. OpenRouter can
  // reject even a short conversation. Remove this cap when Pi accounts for
  // the current request prefix reliably (api/simple-options + utils/estimate).
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "openrouter") return;
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
    const replacement = { ...payload } as Record<string, unknown>;
    let changed = false;
    for (const key of ["max_tokens", "max_completion_tokens"]) {
      const limit = replacement[key];
      if (typeof limit === "number" && Number.isFinite(limit) && limit > 32_768) {
        replacement[key] = 32_768;
        changed = true;
      }
    }
    if (changed) return replacement;
  });

  // Pi deliberately leaves permission policy to extensions. T3's injected
  // bridge uses Pi's public blocking tool hook so the shared runtime modes
  // keep their normal meaning without replacing or shadowing Pi's runtime.
  // Only Pi's own search is known to be read-only. An extension that replaces
  // it keeps the name, and cannot discover deferred tools either.
  const hasBuiltinToolSearch = () =>
    typeof pi.getAllTools === "function" &&
    pi.getAllTools().some((tool) => tool.name === "tool_search" && tool.sourceInfo?.path === "builtin:tool-search");

  const readOnlyMcpTools = new Set<string>();
  const ownsTool = (name: string) => {
    const extensionPath = env(EXTENSION_PATH_ENV);
    if (extensionPath === undefined || typeof pi.getAllTools !== "function") return false;
    // A user extension may own the same name. Only our registered HTTP bridge
    // may inherit the canonical T3 server's read-only annotation.
    return pi.getAllTools().some((tool) => tool.name === name &&
      typeof tool.sourceInfo?.path === "string" &&
      NodePath.resolve(tool.sourceInfo.path) === NodePath.resolve(extensionPath));
  };
  const isReadOnlyMcpTool = (name: string) => readOnlyMcpTools.has(name) && ownsTool(name);
  const isReadThroughGoatCall = (name: string, input: unknown) => {
    if (name !== "mcp__goat__goat_call" || typeof input !== "object" || input === null) return false;
    const path = (input as { readonly path?: unknown }).path;
    return typeof path === "string" && GOAT_CALL_READ_TARGETS.has(path) && ownsTool(name);
  };

  pi.on("tool_call", async (event, ctx) => {
    const mode = runtimeMode();
    if (mode === "full-access") return;
    if ((event.toolName === "tool_search" ? hasBuiltinToolSearch() : READ_ONLY_TOOLS.has(event.toolName)) ||
      isReadOnlyMcpTool(event.toolName) || isReadThroughGoatCall(event.toolName, event.input)) {
      return;
    }
    if (mode === "auto-accept-edits" && FILE_CHANGE_TOOLS.has(event.toolName)) {
      return;
    }
    const approved = await ctx.ui.confirm(
      \`Allow \${event.toolName}?\`,
      toolInputSummary(event.input),
      { signal: ctx.signal },
    );
    if (!approved) {
      return { block: true, reason: \`\${event.toolName} was declined in GOAT.\` };
    }
  });

  const endpoint = env(URL_ENV);
  const token = env(TOKEN_ENV);
  if (endpoint === undefined || token === undefined) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify(
        "goat MCP unavailable: GOAT_MCP_URL or GOAT_MCP_BEARER_TOKEN is missing.",
        "warning",
      );
    });
    // The development discipline does not depend on GOAT's tools, so it still applies here.
    pi.on("before_agent_start", async (event) => {
      const sections = event.systemPromptOptions?.sections;
      if (sections && typeof sections === "object" && event.systemPromptOptions?.forceSystemPrompt === undefined) {
        sections.goat_code_development = DEVELOPMENT_INSTRUCTIONS;
        return undefined;
      }
      return { systemPrompt: event.systemPrompt + "\\n\\n" + DEVELOPMENT_INSTRUCTIONS };
    });
    return;
  }

  // Tool exposure arrived with registerMcpServer in Pi 0.99. Keep the HTTP
  // bridge as the credential owner: mcp.json overrides native registrations.
  const supportsExposure = "registerMcpServer" in pi && typeof pi.registerMcpServer === "function";
  let deferOptionalTools = supportsExposure;
  let catalog: ReadonlyArray<McpTool> = [];

  const client = createMcpClient(endpoint, token);
  let started: Promise<void> | undefined;

  const registerTools = () => {
    // The public and normalized goat namespaces are identical. One registration
    // reserves ownership without a hidden alias shadowing the callable tool.
    readOnlyMcpTools.clear();
    for (const tool of catalog) {
      const name = tool.name;
      const registeredName = \`mcp__goat__\${name}\`;
      if (tool.annotations?.readOnlyHint === true) readOnlyMcpTools.add(registeredName);
      // The server marks its resident tools; Pi defers the rest only while tool_search can find them.
      const exposure = deferOptionalTools && tool._meta?.[ALWAYS_LOAD_META_KEY] !== true ? "deferred" : "direct";
      pi.registerTool({
        name: registeredName,
        label: name,
        description: tool.description ?? name,
        parameters: jsonSchemaToTypebox(tool.inputSchema),
        ...(supportsExposure ? { outputSchema: mcpOutputSchema(tool) } : {}),
        ...(supportsExposure ? { exposure } : {}),
        async execute(_toolCallId, params, signal) {
          const result = await client.callTool(
            name,
            (params ?? {}) as Record<string, unknown>,
            signal,
          );
          const content = mcpModelContent(result);
          if (isMcpToolError(result) && !content.some((part) => part.type === "text" && part.text.length > 0)) {
            content.push({ type: "text", text: "MCP tool goat/" + name + " returned an error" });
          }
          return {
            content,
            structuredContent: mcpScriptResult(result),
            details: { server: "goat", tool: name },
            ...(isMcpToolError(result) ? { isError: true } : {}),
          };
        },
      });
    }
  };

  const ensureStarted = () => {
    if (started !== undefined) return started;
    const attempt = (async () => {
      const signal = AbortSignal.timeout(10_000);
      await client.connect(signal);
      catalog = await client.listTools(signal);
      registerTools();
    })();
    started = attempt;
    void attempt.catch(() => {
      if (started === attempt) started = undefined;
    });
    return attempt;
  };

  // CLI extensions load before builtins, and Pi keeps the first registration
  // of a tool name. Register now so the bridge owns the GOAT namespace even when
  // mcp.json configures it; retry a failed connection at session_start.
  await ensureStarted().catch(() => undefined);

  const reconcileDiscovery = (ctx: Pick<ExtensionContext, "model">) => {
    if (!supportsExposure) return;
    // A disabled or replaced search builtin cannot discover deferred tools.
    const hasToolSearch = hasBuiltinToolSearch();
    const exposureChanged = deferOptionalTools !== hasToolSearch;
    deferOptionalTools = hasToolSearch;
    if (exposureChanged) registerTools();
    const active = pi.getActiveTools();
    // Completion gateways can silently drop calls to undeclared tools named
    // in history or guidance. Eagerly load GOAT schemas, including after tree
    // restores, while retaining deferred exposure for Pi's allowlist rules.
    // Pi still applies --tools/--exclude-tools to this active loadout.
    const required = [
      ...(hasToolSearch ? ["tool_search"] : []),
      ...(ctx.model?.api === "openai-completions" ? catalog.map((tool) => "mcp__goat__" + tool.name) : []),
    ];
    const missing = required.filter((name) => !active.includes(name));
    if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
  };

  // Tree navigation restores its saved loadout after session_start.
  pi.on("session_tree", (_event, ctx) => reconcileDiscovery(ctx));
  pi.on("model_select", (_event, ctx) => reconcileDiscovery(ctx));
  pi.on("session_start", async (_event, ctx) => {
    reconcileDiscovery(ctx);
    try {
      await ensureStarted();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(\`goat MCP unavailable: \${message}\`, "warning");
    }
  });

  // The managed Cua Driver, registered as mcp__cua-driver__<tool> like other
  // harnesses name it. Its screenshots pass through as image content.
  const cua = cuaSpec();
  let computerUse = false;
  // Turns this process may not use the driver on (Plan, read-only, a changed driver) close it.
  let cuaOpen = true;
  const cuaToolNames: string[] = [];
  let closeCua: () => void = () => undefined;
  if (cua !== undefined) {
    const cuaClient = createStdioMcpClient(cua);
    closeCua = () => cuaClient.close();
    pi.on("session_shutdown", () => cuaClient.close());
    try {
      const signal = AbortSignal.timeout(20_000);
      await cuaClient.connect(signal);
      for (const tool of await cuaClient.listTools(signal)) {
        const name = tool.name;
        const description = tool.description ?? name;
        cuaToolNames.push("mcp__cua-driver__" + name);
        pi.registerTool({
          name: \`mcp__cua-driver__\${name}\`,
          label: name,
          description,
          promptSnippet: description.split("\\n")[0] ?? name,
          parameters: jsonSchemaToTypebox(tool.inputSchema),
          async execute(_toolCallId, params, signal) {
            if (!cuaOpen)
              return {
                content: [{ type: "text", text: "Computer use is off for this turn." }],
                details: { server: "cua-driver", tool: name },
                isError: true,
              };
            const result = await cuaClient.callTool(
              name,
              (params ?? {}) as Record<string, unknown>,
              signal,
            );
            return {
              content: mcpModelContent(result),
              details: { server: "cua-driver", tool: name },
              ...(isMcpToolError(result) ? { isError: true } : {}),
            };
          },
        });
      }
      computerUse = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pi.on("session_start", async (_event, ctx) => {
        ctx.ui.notify(\`Cua Driver unavailable: \${message}\`, "warning");
      });
    }
  }

  // Keep guidance in the system prompt so leading slash commands still expand.
  pi.on("before_agent_start", async (event, ctx) => {
    reconcileDiscovery(ctx);
    if (computerUse) {
      const open = await readCuaGate();
      if (!open && cuaOpen) {
        // End the driver connection before the turn starts, not just its tools.
        closeCua();
        pi.setActiveTools(pi.getActiveTools().filter((name) => !cuaToolNames.includes(name)));
      } else if (open && !cuaOpen) {
        const active = pi.getActiveTools();
        pi.setActiveTools([...active, ...cuaToolNames.filter((name) => !active.includes(name))]);
      }
      cuaOpen = open;
    }
    const withComputerUse = computerUse && cuaOpen;
    const sections = event.systemPromptOptions?.sections;
    if (sections && typeof sections === "object" && event.systemPromptOptions?.forceSystemPrompt === undefined) {
      // A full prompt override bypasses Pi's later section rendering.
      sections.goat_code_development = DEVELOPMENT_INSTRUCTIONS;
      sections.goat_code_orchestration = ORCHESTRATION_INSTRUCTIONS;
      if (withComputerUse) sections.goat_computer_use = COMPUTER_USE_INSTRUCTIONS;
      else delete sections.goat_computer_use;
      return undefined;
    }
    return {
      systemPrompt:
        event.systemPrompt +
        "\\n\\n" +
        DEVELOPMENT_INSTRUCTIONS +
        "\\n\\n" +
        ORCHESTRATION_INSTRUCTIONS +
        (withComputerUse ? "\\n\\n" + COMPUTER_USE_INSTRUCTIONS : ""),
    };
  });
}
`;
