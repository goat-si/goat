// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalConsole:off - a plain Node script an agent runs against a live server; no Effect runtime.
/**
 * How much of an agent's first prompt GOAT takes, per harness: the tool listing each harness puts
 * in front of the model plus the GOAT instruction text GOAT sends it.
 *
 *   GOAT_CONTEXT_ENDPOINT=http://127.0.0.1:<port>/mcp GOAT_CONTEXT_AUTHORIZATION="Bearer ..." \
 *     node scripts/agent-surface/context.ts [--json] [--save-listing <file>]
 *   node scripts/agent-surface/context.ts --listing <file> [--json]
 *
 * Without GOAT_CONTEXT_*, it uses GOAT_ACP_MCP_ENDPOINT and GOAT_ACP_MCP_AUTHORIZATION, which GOAT
 * sets for ACP agents, so a thread measures the listing it is actually given. A thread credential
 * and an outside client can see different listings; say which one a number came from.
 *
 * Bytes are UTF-8 bytes of what the harness serializes. Tokens are bytes / 4, an estimate; JSON
 * schema usually tokenizes denser than prose, so read them as a floor.
 */
import * as NodeFS from "node:fs";

type Json =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json };
type JsonObject = { readonly [key: string]: Json };
interface ListedTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: JsonObject;
  readonly outputSchema?: JsonObject;
}

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const asJson = args.includes("--json");
const listingFile = flag("--listing");
const saveListing = flag("--save-listing");
const endpoint = process.env.GOAT_CONTEXT_ENDPOINT ?? process.env.GOAT_ACP_MCP_ENDPOINT;
const authorization =
  process.env.GOAT_CONTEXT_AUTHORIZATION ?? process.env.GOAT_ACP_MCP_AUTHORIZATION;

const bytes = (value: string) => Buffer.byteLength(value, "utf8");
const json = (value: unknown) => bytes(JSON.stringify(value));

const listLive = async (): Promise<ReadonlyArray<ListedTool>> => {
  if (endpoint === undefined || authorization === undefined)
    throw new Error(
      "Set GOAT_CONTEXT_ENDPOINT and GOAT_CONTEXT_AUTHORIZATION, run inside a GOAT thread, or pass --listing <file>.",
    );
  let session: string | null = null;
  let id = 0;
  const rpc = async (method: string, params: JsonObject, notification = false) => {
    const requestId = ++id;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization,
        ...(session === null
          ? {}
          : { "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" }),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method,
        params,
        ...(notification ? {} : { id: requestId }),
      }),
    });
    session = response.headers.get("mcp-session-id") ?? session;
    if (!response.ok) throw new Error(method + ": HTTP " + response.status);
    const text = await response.text();
    if (notification) return {};
    const messages = (response.headers.get("content-type") ?? "").includes("text/event-stream")
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => JSON.parse(line.slice(5)) as JsonObject)
      : [JSON.parse(text) as JsonObject];
    const message = messages.find((candidate) => candidate["id"] === requestId);
    if (message === undefined || message["error"] !== undefined)
      throw new Error(method + ": " + JSON.stringify(message?.["error"] ?? "no response"));
    return message["result"] as JsonObject;
  };
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "goat-agent-surface-context", version: "1" },
  });
  await rpc("notifications/initialized", {}, true);
  const tools: Array<ListedTool> = [];
  let cursor: string | undefined;
  do {
    const page = await rpc("tools/list", cursor === undefined ? {} : { cursor });
    tools.push(...(page["tools"] as unknown as ReadonlyArray<ListedTool>));
    cursor = typeof page["nextCursor"] === "string" ? page["nextCursor"] : undefined;
  } while (cursor !== undefined);
  return tools;
};

const tools: ReadonlyArray<ListedTool> =
  listingFile === undefined
    ? await listLive()
    : (JSON.parse(NodeFS.readFileSync(listingFile, "utf8")) as ReadonlyArray<ListedTool>);
if (saveListing !== undefined) NodeFS.writeFileSync(saveListing, JSON.stringify(tools));

// The instruction text GOAT sends each harness, built by the functions the adapters call.
// Loaded at run time: the scripts project does not compile these packages.
const load = async <A>(path: string) =>
  (await import(new URL("../../" + path, import.meta.url).href)) as A;
const orchestration = await load<{
  readonly GOAT_ORCHESTRATION_INSTRUCTIONS: string;
  readonly goatAcpPromptWithInstructions: (input: {
    readonly prompt: string;
    readonly state: { readonly interactionMode: "default"; readonly hasGoatMcp: boolean };
  }) => string;
  readonly goatOrchestrationPromptForFirstRun: (input: {
    readonly prompt: string;
    readonly runOrdinal: number;
    readonly hasGoatMcp: boolean;
  }) => string;
  readonly goatOrchestrationSystemPrompt: (hasGoatMcp: boolean) => string;
}>("packages/provider-core/src/server/orchestrationInstructions.ts");
const { GOAT_DEVELOPMENT_INSTRUCTIONS } = await load<{
  readonly GOAT_DEVELOPMENT_INSTRUCTIONS: string;
}>("packages/provider-core/src/server/developmentInstructions.ts");
const { buildRuntimeInstructions } = await load<{
  readonly buildRuntimeInstructions: (runtime: { readonly harness: string }) => string;
}>("packages/provider-core/src/server/runtimeInstructions.ts");
const { MEMORY_DATA_BOUNDARY_REMINDER } = await load<{
  readonly MEMORY_DATA_BOUNDARY_REMINDER: string;
}>("packages/provider-core/src/server/memoryContext.ts");
const codex = await load<{
  readonly buildCodexDeveloperInstructions: (mode: "default") => string;
  readonly buildCodexAdditionalContext: (
    runtime: { readonly model: string },
    tools: boolean,
  ) => Readonly<Record<string, { readonly value: string }>>;
}>("apps/server/src/provider/CodexDeveloperInstructions.ts");

const firstRunWrapper = (text: string) => text.replace("<user_request>\n\n</user_request>", "");
const instructions = {
  // ClaudeAdapterV2 appends these to the claude_code preset system prompt.
  claude: [
    buildRuntimeInstructions({ harness: "Claude Code" }),
    MEMORY_DATA_BOUNDARY_REMINDER,
    GOAT_DEVELOPMENT_INSTRUCTIONS + orchestration.GOAT_ORCHESTRATION_INSTRUCTIONS,
  ].join("\n\n"),
  // Collaboration mode as developer instructions, the rest as additional context on every turn.
  codex: [
    codex.buildCodexDeveloperInstructions("default"),
    ...Object.values(codex.buildCodexAdditionalContext({ model: "gpt" }, true)).map(
      (entry) => entry.value,
    ),
  ].join("\n\n"),
  opencode: [
    buildRuntimeInstructions({ harness: "OpenCode" }),
    orchestration.goatOrchestrationSystemPrompt(true),
  ].join("\n\n"),
  cursor: [
    buildRuntimeInstructions({ harness: "Cursor" }),
    firstRunWrapper(
      orchestration.goatOrchestrationPromptForFirstRun({
        prompt: "",
        runOrdinal: 1,
        hasGoatMcp: true,
      }),
    ),
  ].join("\n\n"),
  acp: [
    buildRuntimeInstructions({ harness: "ACP" }),
    firstRunWrapper(
      orchestration.goatAcpPromptWithInstructions({
        prompt: "",
        state: { interactionMode: "default", hasGoatMcp: true },
      }),
    ),
  ].join("\n\n"),
} as const;

type Shape = "anthropic" | "openai" | "names" | "deferred";
/** The tool definition a harness sends its model API for one MCP tool. */
const definition = (shape: "anthropic" | "openai", prefix: string, tool: ListedTool): unknown =>
  shape === "anthropic"
    ? { name: prefix + tool.name, description: tool.description, input_schema: tool.inputSchema }
    : {
        type: "function",
        name: prefix + tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      };

/**
 * How each harness puts MCP tools in front of its model, as of 2026-10. "names" keeps only the
 * tool names in context until the model searches; "deferred" keeps none of them, only the
 * harness's own search tool. Sources:
 * - Claude Code defers every MCP tool unless ENABLE_TOOL_SEARCH=false or the model predates
 *   tool search: https://code.claude.com/docs/en/mcp
 * - Codex defers MCP tools behind tool_search where the model supports it:
 *   https://github.com/openai/codex/pull/29486; code mode hides them from exec:
 *   https://github.com/openai/codex/pull/17287
 * - Cursor gives the agent tool names and keeps descriptions in files:
 *   https://cursor.com/blog/dynamic-context-discovery
 * - OpenCode loads every schema unless its experimental code mode is on:
 *   https://opencode.ai/docs/mcp-servers/
 * - Gemini CLI registers every discovered tool: https://geminicli.com/docs/tools/mcp-server.md
 */
const HARNESSES: ReadonlyArray<{
  readonly id: string;
  readonly shape: Shape;
  readonly prefix: string;
  readonly instructions: string;
}> = [
  { id: "claude", shape: "names", prefix: "mcp__goat__", instructions: instructions.claude },
  {
    id: "claude-upfront",
    shape: "anthropic",
    prefix: "mcp__goat__",
    instructions: instructions.claude,
  },
  { id: "codex", shape: "deferred", prefix: "", instructions: instructions.codex },
  { id: "codex-upfront", shape: "openai", prefix: "mcp__goat__", instructions: instructions.codex },
  { id: "cursor", shape: "names", prefix: "", instructions: instructions.cursor },
  { id: "opencode", shape: "openai", prefix: "goat_", instructions: instructions.opencode },
  { id: "acp-upfront", shape: "anthropic", prefix: "", instructions: instructions.acp },
];

const listingBytes = (shape: Shape, prefix: string) =>
  shape === "deferred"
    ? 0
    : shape === "names"
      ? bytes(tools.map((tool) => prefix + tool.name).join("\n"))
      : json(tools.map((tool) => definition(shape, prefix, tool)));

const rows = HARNESSES.map((harness) => {
  const listing = listingBytes(harness.shape, harness.prefix);
  const instructionBytes = bytes(harness.instructions);
  return {
    harness: harness.id,
    shape: harness.shape,
    tools: tools.length,
    listingBytes: listing,
    instructionBytes,
    totalBytes: listing + instructionBytes,
    estimatedTokens: Math.round((listing + instructionBytes) / 4),
  };
});

const descriptions = tools.map((tool) => ({
  name: tool.name,
  description: bytes(tool.description ?? ""),
  input: json(tool.inputSchema ?? {}),
  output: tool.outputSchema === undefined ? 0 : json(tool.outputSchema),
}));
const sum = (pick: (row: (typeof descriptions)[number]) => number) =>
  descriptions.reduce((total, row) => total + pick(row), 0);
const listingSummary = {
  tools: tools.length,
  descriptionBytes: sum((row) => row.description),
  inputSchemaBytes: sum((row) => row.input),
  outputSchemaBytes: sum((row) => row.output),
  toolsListBytes: json({ tools }),
  largest: descriptions
    .toSorted((a, b) => b.description + b.input - (a.description + a.input))
    .slice(0, 10),
};

if (asJson) {
  console.log(JSON.stringify({ listing: listingSummary, harnesses: rows }, null, 2));
} else {
  const kb = (value: number) => (value / 1024).toFixed(1) + " KB";
  console.log(
    "tools/list: " +
      listingSummary.tools +
      " tools, " +
      kb(listingSummary.toolsListBytes) +
      " (descriptions " +
      kb(listingSummary.descriptionBytes) +
      ", input schemas " +
      kb(listingSummary.inputSchemaBytes) +
      ", output schemas " +
      kb(listingSummary.outputSchemaBytes) +
      ")",
  );
  console.log("");
  console.log("harness         shape      tools   listing  instructions     total   ~tokens");
  for (const row of rows)
    console.log(
      row.harness.padEnd(16) +
        row.shape.padEnd(10) +
        String(row.tools).padStart(6) +
        kb(row.listingBytes).padStart(10) +
        kb(row.instructionBytes).padStart(14) +
        kb(row.totalBytes).padStart(10) +
        String(row.estimatedTokens).padStart(10),
    );
  console.log("");
  console.log("largest tools (description + input schema bytes):");
  for (const row of listingSummary.largest)
    console.log(
      "  " +
        row.name.padEnd(36) +
        String(row.description).padStart(7) +
        String(row.input).padStart(8),
    );
}
