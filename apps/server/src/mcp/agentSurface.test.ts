import * as DeviceService from "../device/DeviceService.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  DeviceHostUnavailableError,
  DeviceSession,
  EnvironmentId,
  HandoffSummary,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";
import {
  type McpClientCaller,
  McpInvocationContext,
  type McpInvocationScope,
} from "./McpInvocationContext.ts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { hostArgumentsOf } from "@goat/contracts/agentSurface/hosts";
import {
  canonicalToolAliases,
  canonicalToolName,
  resolveAgentSurfaceEntry,
} from "@goat/contracts/agentSurface/resolve";
import { type AgentSurfaceResult, FAILURE_CLASSES } from "@goat/contracts/agentSurface/envelope";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer, Tool } from "effect/ai";
import { MemoryToolkit } from "./toolkits/memory/tools.ts";

import {
  catalog,
  client,
  dependencies,
  entries,
  serveCatalogOverHttp,
  toolkits,
} from "./agentSurface.testkit.ts";
import {
  GOAT_MCP_CANONICAL_TOOL_ALIASES,
  resolveGoatMcpToolDefinition,
  resolveGoatMcpToolPresentation,
} from "@goat/shared/goatMcpToolPresentation";
import { NodeHttpServer } from "@effect/platform-node";
import { servedToolCallBody } from "./ToolDispatch.ts";

const registered = catalog.pipe(
  Layer.provide(dependencies),
  Layer.provideMerge(McpServer.McpServer.layer),
);

it("gives every entry a unique path, legacy name and resolvable schema reference", () => {
  expect(entries).toHaveLength(199); // Includes current memory, browser, provider (with provider settings), SSH runtime, GOAT Bot home, fleet goal, resource and health, notes (with note update), hub, permission profile and goatclaw sync, computer use, decision, lane, and preparation retry tools.
  expect(new Set(entries.map((entry) => entry.name)).size).toBe(entries.length);
  for (const [path, entry] of Object.entries(agentSurfaceRegistry)) {
    expect(path).toBe(entry.path);
    expect(path).toMatch(/^[a-z][a-z_]*\.[a-z][a-z_]*$/);
    expect(entry.legacyNames).toContain(entry.name);
    const tools: Record<string, Tool.Any> = toolkits[entry.schemaRefs.toolkit].tools;
    const tool = tools[entry.schemaRefs.tool];
    expect(tool, path).toBeDefined();
    expect(Tool.getJsonSchema(tool!)).toMatchObject({ type: "object" });
    expect(tool!.successSchema).toBeDefined();
    expect(tool!.failureSchema).toBeDefined();
    expect(Tool.getDescription(tool!)).toBe(entry.description);
  }
});

it("preserves the memory injection guidance in registry and published descriptions", () => {
  const descriptions = {
    memory_search:
      "Search memory (default scope: user). fts is phrase search; use mode substring for partial text. Pass nextCursor unchanged with the same query and scope, even when items is empty. If indexCoverage is partial/unavailable, do not conclude a memory is absent.",
    memory_upsert:
      "Create or update memory with an explicit memory:write grant. Read-only sessions cannot write. Keep one current assertion per item; correct an existing memory by updating it, not creating another. Do not store progress reports, tool output, or execution summaries.",
  };
  expect(agentSurfaceRegistry["memory.search"].description).toBe(descriptions.memory_search);
  expect(agentSurfaceRegistry["memory.upsert"].description).toBe(descriptions.memory_upsert);
  expect(Tool.getDescription(MemoryToolkit.tools.memory_search)).toBe(descriptions.memory_search);
  expect(Tool.getDescription(MemoryToolkit.tools.memory_upsert)).toBe(descriptions.memory_upsert);
});

it.effect(
  "assembles exactly the registry, with effect hints from each real handler declaration",
  () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      expect(server.tools.map(({ tool }) => tool.name).sort()).toEqual(
        entries.map((entry) => entry.name).sort(),
      );
      for (const entry of entries) {
        const tool = server.tools.find(({ tool }) => tool.name === entry.name)!.tool;
        expect(tool.annotations, entry.path).toMatchObject({
          readOnlyHint: entry.effect === "read",
          destructiveHint: entry.effect === "destructive",
        });
      }
      // Audit mismatches: hints follow the current gates, including task_status's write gate.
      const hints = (name: string) =>
        server.tools.find(({ tool }) => tool.name === name)!.tool.annotations;
      expect(hints("goat_ssh_browse")?.readOnlyHint).toBe(false);
      expect(hints("goat_thread_read")?.readOnlyHint).toBe(true);
      expect(hints("preview_snapshot")?.readOnlyHint).toBe(true);
      expect(hints("task_status")?.readOnlyHint).toBe(false);
      expect(hints("goat_review_findings_record")?.readOnlyHint).toBe(false);
      expect(hints("goat_review_findings_export")?.readOnlyHint).toBe(true);
      expect(hints("goat_worktree_cleanup")?.destructiveHint).toBe(true);
    }).pipe(Effect.provide(registered)),
);

it.effect("publishes closed top-level schemas and refuses unknown keys for the whole catalog", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const { tool } of server.tools) {
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
      const result = yield* server
        .callTool({ name: tool.name, arguments: { misspelledHost: "box" } })
        .pipe(Effect.provideService(McpSchema.McpServerClient, client));
      expect(result.isError, tool.name).toBe(true);
      const content = result.content[0];
      expect(content?.type).toBe("text");
      if (content?.type === "text")
        expect(JSON.parse(content.text)).toMatchObject({ code: "invalid_request" });
    }
  }).pipe(Effect.provide(registered)),
);

type Entry = (typeof agentSurfaceRegistry)[keyof typeof agentSurfaceRegistry];
const registeredNames = new Set<string>(entries.map((entry) => entry.name));
const toolOf = (entry: Entry): Tool.Any =>
  (toolkits[entry.schemaRefs.toolkit].tools as Record<string, Tool.Any>)[entry.schemaRefs.tool]!;

type JsonSchema = { readonly [key: string]: unknown };
const isObject = (value: unknown): value is JsonSchema =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const children = (node: unknown): ReadonlyArray<unknown> =>
  Array.isArray(node) ? node : isObject(node) ? Object.values(node) : [];
const refsIn = (node: unknown): ReadonlyArray<string> => [
  ...(isObject(node) && typeof node["$ref"] === "string" ? [node["$ref"]] : []),
  ...children(node).flatMap(refsIn),
];
const definitionName = (ref: string) => /^#\/\$defs\/(.+)$/.exec(ref)?.[1];
const unresolvedRefs = (root: unknown, definitions: JsonSchema) =>
  [...refsIn(root), ...refsIn(definitions)].filter((ref) => {
    const name = definitionName(ref);
    return name === undefined || !(name in definitions);
  });
const resolve = (node: unknown, definitions: JsonSchema): unknown => {
  const name =
    isObject(node) && typeof node["$ref"] === "string" ? definitionName(node["$ref"]) : undefined;
  return name === undefined ? node : resolve(definitions[name], definitions);
};
const literals = (node: unknown): ReadonlyArray<unknown> =>
  !isObject(node)
    ? []
    : "const" in node
      ? [node["const"]]
      : Array.isArray(node["enum"])
        ? node["enum"]
        : [];
const propertiesOf = (node: unknown, definitions: JsonSchema): JsonSchema => {
  const resolved = resolve(node, definitions);
  return isObject(resolved) && isObject(resolved["properties"]) ? resolved["properties"] : {};
};

// Writes whose `host` names something other than a fleet machine the call acts on.
const NOT_A_FLEET_HOST: Readonly<Record<string, string>> = {
  "connection.add_ssh": "the address of a machine being added, gated by hub.manage",
  "ssh.host_add": "the address of a machine being added, gated by hub.manage",
  "pull_request.link": "the git forge's host",
  "pull_request.unlink": "the git forge's host",
  "pull_request.watch": "the git forge's host",
  "pull_request.unwatch": "the git forge's host",
};

it("declares every write argument that names a host, so the goatclaw host allowlist checks it", () => {
  for (const entry of entries) {
    if (entry.effect === "read" || entry.path in NOT_A_FLEET_HOST) continue;
    const document = Schema.toJsonSchemaDocument(toolOf(entry).parametersSchema);
    const named = Object.keys(propertiesOf(document.schema, document.definitions)).filter(
      (key) => key === "host" || key.endsWith("Host") || key.endsWith("Alias"),
    );
    expect(hostArgumentsOf(entry).toSorted(), entry.path).toEqual(named.toSorted());
  }
});

/** Every object schema reachable from a result schema whose kind is the literal needs_human. */
const needsHumanArms = (document: { schema: unknown; definitions: JsonSchema }) => {
  const arms: Array<JsonSchema> = [];
  const visit = (node: unknown) => {
    if (isObject(node) && isObject(node["properties"])) {
      const kind = literals(resolve(node["properties"]["kind"], document.definitions));
      if (kind.length === 1 && kind[0] === "needs_human") arms.push(node);
    }
    for (const child of children(node)) visit(child);
  };
  visit(document.schema);
  visit(document.definitions);
  return arms;
};
const resultDocument = (entry: Entry) => {
  const document = Schema.toJsonSchemaDocument(toolOf(entry).successSchema);
  return { schema: document.schema, definitions: document.definitions as JsonSchema };
};

describe("agent surface schemas", () => {
  it("renders every input, success and failure schema as self-contained JSON Schema", () => {
    for (const entry of entries) {
      const tool = toolOf(entry);
      const input = Tool.getJsonSchema(tool) as JsonSchema;
      const inputDefinitions = isObject(input["$defs"]) ? input["$defs"] : {};
      expect(unresolvedRefs(input, inputDefinitions), `${entry.path} input`).toEqual([]);
      for (const [slot, schema] of [
        ["success", tool.successSchema],
        ["failure", tool.failureSchema],
      ] as const) {
        const document = Schema.toJsonSchemaDocument(schema);
        expect(
          unresolvedRefs(document.schema, document.definitions as JsonSchema),
          `${entry.path} ${slot}`,
        ).toEqual([]);
      }
    }
  });
});

// goat_call returns the envelope, whose needs_human is a status rather than a kind; checked below.
const ENVELOPE_NEEDS_HUMAN = new Set(["surface.call"]);

describe("agent surface needs_human results", () => {
  it("hands work to a person only through the shared handoff summary and a registered next call", () => {
    const summaryKeys = Object.keys(HandoffSummary.fields).sort();
    const problems: Array<string> = [];
    for (const entry of entries) {
      const document = resultDocument(entry);
      for (const arm of needsHumanArms(document)) {
        if (entry.humanSteps.length === 0) problems.push(`${entry.path}: no humanSteps`);
        const required = Array.isArray(arm["required"]) ? arm["required"] : [];
        if (!required.includes("handoff")) problems.push(`${entry.path}: handoff not required`);
        const properties = arm["properties"] as JsonSchema;
        const handoffKeys = Object.keys(
          propertiesOf(properties["handoff"], document.definitions),
        ).sort();
        if (handoffKeys.join() !== summaryKeys.join())
          problems.push(`${entry.path}: handoff fields ${handoffKeys.join(",")}`);
        const next = propertiesOf(properties["next"], document.definitions);
        const calls = literals(resolve(next["call"], document.definitions));
        if (calls.length === 0) problems.push(`${entry.path}: no next.call`);
        for (const call of calls)
          if (!registeredNames.has(String(call)))
            problems.push(`${entry.path}: next.call ${String(call)}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("returns a handoff from every tool that documents needs_human", () => {
    const missing = entries.filter(
      (entry) =>
        entry.description.includes("needs_human") &&
        !ENVELOPE_NEEDS_HUMAN.has(entry.path) &&
        needsHumanArms(resultDocument(entry)).length === 0,
    );
    expect(missing.map((entry) => entry.path)).toEqual([]);
  });

  it("passes the shared handoff summary through goat_call's needs_human status", () => {
    const document = resultDocument(agentSurfaceRegistry["surface.call"]);
    const arms: Array<JsonSchema> = [];
    const visit = (node: unknown) => {
      if (isObject(node) && isObject(node["properties"])) {
        const status = literals(resolve(node["properties"]["status"], document.definitions));
        if (status.length === 1 && status[0] === "needs_human") arms.push(node);
      }
      for (const child of children(node)) visit(child);
    };
    visit(document.schema);
    visit(document.definitions);
    expect(arms).toHaveLength(1);
    const arm = arms[0]!;
    expect(arm["required"]).toContain("handoff");
    const handoffKeys = Object.keys(
      propertiesOf((arm["properties"] as JsonSchema)["handoff"], document.definitions),
    ).sort();
    expect(handoffKeys).toEqual(Object.keys(HandoffSummary.fields).sort());
  });
});

// Callers the access layer distinguishes (McpToolAccess.ts, McpInvocationContext.ts).
const scopeBase = {
  environmentId: EnvironmentId.make("environment:conformance"),
  requestNamespace: "conformance",
  issuedAt: 0,
  capabilities: new Set([
    "memory",
    "preview",
    "orchestration",
    "worktree",
    "device",
    "pull-requests",
  ] as const),
  grantedScopes: [],
};
const callers = {
  thread: {
    ...scopeBase,
    thread: {
      threadId: ThreadId.make("thread:conformance"),
      providerSessionId: "session:conformance",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
  },
  readOnlyClient: {
    ...scopeBase,
    readOnly: true,
    thread: undefined,
    client: { sessionId: "client:read-only", label: "read-only", access: "read-only" },
  },
  fullClient: {
    ...scopeBase,
    thread: undefined,
    client: { sessionId: "client:full", label: "full", access: "full-access" },
  },
} satisfies Record<string, McpInvocationScope>;
type Caller = keyof typeof callers;
const TARGET_THREAD = "thread:conformance-target";

/**
 * reached: the access layer let the call into its handler, which then met inert services.
 * unexpected and defect never match an expectation, so a wrong argument or a crash before the
 * handler cannot pass as access granted.
 */
type Outcome = "thread_required" | "read_only" | "denied" | "reached" | "unexpected" | "defect";
const INERT_SERVICE_DEFECT = "inert service";
// The tool-level wrapper's text when a handler dies on an inert service.
const HANDLER_DIED = "Tool execution failed due to an internal server error.";
// Refusals a handler makes after access passed, from its own domain checks.
const HANDLER_CODES = new Set(["target_required", "orchestration_error"]);
// invalid_request from a rule the handler checks after access, on these sampled inputs.
const HANDLER_VALIDATION: Readonly<Record<string, string>> = {
  "attachment.discard": "Only the caller that prepared an upload may discard it.",
  "thread.reschedule": "A caller outside a thread must pass a model to resume with.",
  "project.create": "A project made from a title takes no other settings.",
};
const IMAGE_TOOL_FAILURE = /^(Preview snapshot|Device screenshot) failed/;
const classify = (path: string, result: McpSchema.CallToolResult): Outcome => {
  const content = result.content[0];
  const text = content?.type === "text" ? content.text : "";
  if (!result.isError) return "reached";
  if (text === INERT_SERVICE_DEFECT || text === HANDLER_DIED) return "reached";
  if (text.startsWith("defect:")) return "defect";
  if (/thread_credential_required|acts as the calling GOAT thread/.test(text))
    return "thread_required";
  // Some toolkits (pull requests, images) return the refusal message without its code.
  if (/approved for read-only access/.test(text)) return "read_only";
  if (/"code":"capability_denied"/.test(text)) return "denied";
  if (IMAGE_TOOL_FAILURE.test(text)) return "reached";
  const code = /"code":"([a-z_]+)"/.exec(text)?.[1];
  if (code === "invalid_request" && path in HANDLER_VALIDATION) return "reached";
  return code !== undefined && HANDLER_CODES.has(code) ? "reached" : "unexpected";
};

// Inputs the schema sampler cannot satisfy, and reads that reach other machines with this
// machine's SSH keys unless asked for the local answer.
const FIXTURE_ARGS: Readonly<Record<string, Record<string, unknown>>> = {
  "note.read": { path: "inbox/note.md" },
  "note.write": { path: "inbox/note.md", body: "- [ ] item", status: null, baseRevision: null },
  "note.update": { path: "inbox/note.md", pinned: true },
  "note.move": { from: "inbox/note.md", to: "done/note.md", baseRevision: "0".repeat(64) },
  "channel.task_export": { from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z" },
  "scheduler.status": { local: false },
  "pending_request.list": { scope: "launched", hosts: ["box"] },
  "provider.host_matrix": { localOnly: false },
  "host.status": { local: null },
};

const REASONS = {
  serviceThreadCheck: "Requires a thread inside its service, after the access layer.",
  imageTool: "preview_snapshot reports refusals as text without a code (McpHttpServer.ts).",
  sshFanOut:
    "Reaches other machines with this machine's SSH keys, which read-only clients may not use.",
  dryRunDefault: "Defaults to a dry run, which reads.",
  clientOnly: "Only another GOAT's dispatch session may call it.",
  grantChecked: "Checks a scope the test client does not hold, inside its handler.",
  dispatches: "Runs other tools, each under its own declaration, and adds no gate of its own.",
} as const;
// Where the runtime outcome differs from what requires and effect alone predict, and why.
// The service checks, SSH refusal wording and codeless refusals are tracked in #791.
const ACCESS_EXCEPTIONS: Readonly<
  Record<string, { readonly reason: keyof typeof REASONS } & Partial<Record<Caller, Outcome>>>
> = {
  "goal.apply": {
    reason: "serviceThreadCheck",
    readOnlyClient: "read_only",
    fullClient: "reached",
  },
  "goal.pause": {
    reason: "serviceThreadCheck",
    readOnlyClient: "read_only",
    fullClient: "reached",
  },
  "goal.resume": {
    reason: "serviceThreadCheck",
    readOnlyClient: "read_only",
    fullClient: "reached",
  },
  "goal.delete": {
    reason: "serviceThreadCheck",
    readOnlyClient: "read_only",
    fullClient: "reached",
  },
  "provider.home_request": {
    reason: "serviceThreadCheck",
    readOnlyClient: "read_only",
    fullClient: "reached",
  },
  "provider.setup_open": {
    reason: "serviceThreadCheck",
    readOnlyClient: "read_only",
    fullClient: "reached",
  },
  "preview.snapshot": { reason: "imageTool", readOnlyClient: "reached", fullClient: "reached" },
  "scheduler.status": { reason: "sshFanOut", readOnlyClient: "read_only" },
  "pending_request.list": { reason: "sshFanOut", readOnlyClient: "read_only" },
  "provider.host_matrix": { reason: "sshFanOut", readOnlyClient: "read_only" },
  "hub.device_verify": { reason: "sshFanOut", readOnlyClient: "read_only" },
  "host.status": { reason: "sshFanOut", readOnlyClient: "read_only" },
  "cloud_agent.holders": { reason: "sshFanOut", readOnlyClient: "read_only" },
  "worktree.cleanup": { reason: "dryRunDefault", readOnlyClient: "reached" },
  "permission_profile.sync": { reason: "clientOnly", thread: "denied", fullClient: "denied" },
  "channel.task_move": { reason: "grantChecked", thread: "denied", fullClient: "denied" },
  "cloud_machine.create": { reason: "grantChecked", thread: "denied", fullClient: "denied" },
  "cloud_machine.stop": { reason: "grantChecked", thread: "denied", fullClient: "denied" },
  "cloud_machine.resume": { reason: "grantChecked", thread: "denied", fullClient: "denied" },
  "surface.call": { reason: "dispatches", readOnlyClient: "reached" },
};

const expectedOutcome = (entry: Entry, caller: Caller, route: Route): Outcome => {
  const exception = ACCESS_EXCEPTIONS[entry.path];
  // goat_call reports the refusal an image tool's own text hides.
  const applies = !(route === "goat_call" && exception?.reason === "imageTool");
  if (applies && exception?.[caller] !== undefined) return exception[caller];
  if (caller === "thread") return entry.requires === "client" ? "denied" : "reached";
  if (entry.requires === "thread") return "thread_required";
  if (caller === "readOnlyClient" && entry.effect !== "read") return "read_only";
  return "reached";
};

// One decodable input per entry: sampled from the tool's own schema with a seed from its path,
// then encoded through the JSON codec production decodes with (McpHttpServer decodeAsAdvertised).
const argumentsFor = Effect.fn(function* (entry: Entry) {
  const fixture = FIXTURE_ARGS[entry.path];
  if (fixture !== undefined) return fixture;
  const tool = toolOf(entry);
  // A schema the sampler cannot derive needs an entry in FIXTURE_ARGS.
  const [sample] = yield* Arbitrary.sampleEffect(Arbitrary.schema(tool.parametersSchema), {
    count: 1,
    seed: entry.path,
  });
  // Tool.Any erases the codec's services; tool parameter schemas need none.
  const codec = Schema.toCodecJson(tool.parametersSchema) as unknown as Schema.Codec<unknown>;
  const sampled = yield* Schema.encodeUnknownEffect(codec)(sample);
  const encoded: Record<string, unknown> = isObject(sampled) ? sampled : {};
  // Routing to another host has its own tests; this matrix asks about the local call.
  const schema = Tool.getJsonSchema(tool) as JsonSchema;
  const required = schema["required"];
  const hostRequired = Array.isArray(required) && required.includes("host");
  const takesThread = isObject(schema["properties"]) && "threadId" in schema["properties"];
  return {
    ...encoded,
    ...(entry.hostRoutable && "host" in encoded && !hostRequired ? { host: null } : {}),
    // Outside clients name their target thread; without one they stop at target resolution.
    ...(takesThread && (encoded["threadId"] ?? null) === null ? { threadId: TARGET_THREAD } : {}),
  };
});

const via = {
  direct: (name: string, args: Record<string, unknown>) =>
    McpServer.McpServer.pipe(
      Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    ),
  // The envelope's reason and message stand in for the direct result's text.
  goat_call: (name: string, args: Record<string, unknown>) =>
    McpServer.McpServer.pipe(
      Effect.flatMap((server) =>
        server.callTool({ name: "goat_call", arguments: { path: name, args } }),
      ),
      Effect.map((result) => {
        const envelope = result.structuredContent as AgentSurfaceResult;
        if (envelope.status !== "error")
          return new McpSchema.CallToolResult({ isError: false, content: [] });
        // A plain-text failure stays the direct call's own text; a classified one names its code.
        const text =
          envelope.error.reason === "tool_error"
            ? envelope.error.message
            : JSON.stringify({ code: envelope.error.reason, message: envelope.error.message });
        return new McpSchema.CallToolResult({ isError: true, content: [{ type: "text", text }] });
      }),
    ),
};
// alias: the canonical name over HTTP /mcp, which resolves it to the served tool before dispatch.
type Route = keyof typeof via | "alias";
const RPC_INTERNAL_ERROR = 'rpc error: {"code":-32603';
const ROUTES: ReadonlyArray<Route> = [
  ...(Object.keys(via) as ReadonlyArray<keyof typeof via>),
  "alias",
];

describe("agent surface access", () => {
  it.effect("refuses each caller exactly where the registry's requires and effect say", () =>
    Effect.gen(function* () {
      const http = yield* serveCatalogOverHttp(callers);
      const mismatches: Array<string> = [];
      for (const entry of entries) {
        // Memory access is a per-task grant its handlers check; toolkits/memory tests own it.
        if (entry.resource === "memory") continue;
        const args = yield* argumentsFor(entry);
        const alias = canonicalToolName(entry);
        for (const caller of Object.keys(callers) as ReadonlyArray<Caller>) {
          let directOutcome: Outcome | undefined;
          let directDied = false;
          for (const route of ROUTES) {
            // goat_call refuses to call itself by design.
            if (route === "goat_call" && entry.path === "surface.call") continue;
            if (route === "alias" && !canonicalToolAliases.has(alias)) continue;
            const call: Effect.Effect<
              McpSchema.CallToolResult,
              McpSchema.InternalError | McpSchema.InvalidParams,
              McpServer.McpServer
            > =
              route === "alias"
                ? http.callTool(caller, alias, args)
                : via[route](entry.name, args).pipe(
                    Effect.provideService(McpInvocationContext, callers[caller]),
                    Effect.provideService(McpSchema.McpServerClient, client),
                  );
            const result = yield* call.pipe(
              // An inert service dies after the access layer ran; any other defect fails the case.
              Effect.catchDefect((defect) =>
                Effect.succeed(
                  new McpSchema.CallToolResult({
                    isError: true,
                    content: [
                      {
                        type: "text",
                        text: String(defect).includes("UnimplementedError")
                          ? INERT_SERVICE_DEFECT
                          : `defect: ${String(defect)}`,
                      },
                    ],
                  }),
                ),
              ),
            );
            const classified = classify(entry.path, result);
            if (route === "direct") directDied = textOf(result) === INERT_SERVICE_DEFECT;
            // Over HTTP, an image tool that dies answers with JSON-RPC's internal error under any
            // name; it is the same death the direct route caught on an inert service.
            const diedOverHttp =
              route === "alias" && directDied && textOf(result).startsWith(RPC_INTERNAL_ERROR);
            // The envelope turns a refusal inside a successful value into an error; that is a
            // domain answer after access passed, so it still counts as reaching the handler.
            const outcome =
              (route === "goat_call" &&
                classified === "unexpected" &&
                directOutcome === "reached") ||
              diedOverHttp
                ? "reached"
                : classified;
            if (route === "direct") directOutcome = outcome;
            const expected = expectedOutcome(entry, caller, route);
            if (outcome !== expected) {
              const content = result.content[0];
              const detail = content?.type === "text" ? content.text.slice(0, 160) : "";
              mismatches.push(
                `${entry.path} ${caller} ${route}: expected ${expected}, got ${outcome} (${detail})`,
              );
            }
          }
        }
      }
      expect(mismatches).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(registered, NodeHttpServer.layerTest))),
  );

  it("documents every access exception", () => {
    for (const [path, exception] of Object.entries(ACCESS_EXCEPTIONS)) {
      expect(registeredNames, path).toContain(
        agentSurfaceRegistry[path as keyof typeof agentSurfaceRegistry]?.name,
      );
      expect(REASONS[exception.reason], path).toBeDefined();
    }
    for (const path of Object.keys(HANDLER_VALIDATION))
      expect(registeredNames, path).toContain(
        agentSurfaceRegistry[path as keyof typeof agentSurfaceRegistry]?.name,
      );
  });

  // quarantine: #778 goat_eval is gated on measurement (rollout step 11); add a one-call program to via if it ships.
  it.todo(
    "gives a goat_eval call step the same outcome as a direct call for every entry and caller",
  );
});

type JsonNode = Readonly<Record<string, unknown>>;
const literalsOf = (node: unknown, resolve: (node: unknown) => JsonNode | undefined): string[] => {
  const schema = resolve(node);
  if (schema === undefined) return [];
  if (typeof schema.const === "string") return [schema.const];
  if (Array.isArray(schema.enum)) return schema.enum.filter((value) => typeof value === "string");
  for (const key of ["anyOf", "oneOf"] as const)
    if (Array.isArray(schema[key]))
      return schema[key].flatMap((member) => literalsOf(member, resolve));
  return [];
};
/** Domain literals a schema can return as a failure: tagged errors, and refusal arms of results. */
const failureLiterals = (root: unknown, onlyRefusals: boolean): ReadonlyArray<string> => {
  const defs = ((root as JsonNode).$defs ?? {}) as Readonly<Record<string, JsonNode>>;
  const resolve = (node: unknown): JsonNode | undefined => {
    const fields = node as JsonNode | undefined;
    if (fields === undefined || typeof fields !== "object") return undefined;
    const ref = fields.$ref;
    return typeof ref === "string" ? resolve(defs[ref.replace("#/$defs/", "")]) : fields;
  };
  const found = new Set<string>();
  const seen = new Set<unknown>();
  const walk = (node: unknown) => {
    const schema = resolve(node);
    if (schema === undefined || seen.has(schema)) return;
    seen.add(schema);
    const properties = schema.properties as Readonly<Record<string, unknown>> | undefined;
    if (properties !== undefined) {
      const tags = literalsOf(properties._tag, resolve);
      const kinds = [
        ...literalsOf(properties.kind, resolve),
        ...literalsOf(properties.status, resolve),
      ];
      const isFailure = onlyRefusals
        ? kinds.some((kind) => kind === "error" || kind === "refused")
        : tags.length > 0;
      if (isFailure) {
        const reasons = ["code", "reason", "failureCode"].flatMap((key) =>
          literalsOf(properties[key], resolve),
        );
        for (const literal of reasons.length > 0 ? reasons : tags) found.add(literal);
      }
      for (const value of Object.values(properties)) walk(value);
    }
    for (const key of ["anyOf", "oneOf", "allOf"] as const)
      if (Array.isArray(schema[key])) for (const member of schema[key]) walk(member);
    if (schema.items !== undefined) walk(schema.items);
  };
  walk(root);
  return [...found];
};

it("classifies every domain failure literal the served tools can return", () => {
  const missing = new Map<string, Set<string>>();
  for (const toolkit of Object.values(toolkits))
    for (const tool of Object.values<Tool.Any>(toolkit.tools)) {
      const literals = [
        ...failureLiterals(Tool.getJsonSchemaFromSchema(tool.failureSchema), false),
        ...failureLiterals(Tool.getJsonSchemaFromSchema(tool.successSchema), true),
      ];
      for (const literal of literals)
        if (FAILURE_CLASSES[literal] === undefined)
          missing.set(literal, (missing.get(literal) ?? new Set()).add(tool.name));
    }
  expect(
    Object.fromEntries([...missing].map(([literal, names]) => [literal, [...names].sort()])),
  ).toEqual({});
});
const callerScope = (
  caller: { readonly thread: true } | { readonly client: McpClientCaller["access"] },
): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "thread" in caller ? "provider:thread" : "client:session",
  thread:
    "thread" in caller
      ? {
          threadId: ThreadId.make("thread"),
          providerSessionId: "provider:thread",
          providerInstanceId: ProviderInstanceId.make("codex"),
        }
      : undefined,
  client:
    "thread" in caller
      ? undefined
      : { sessionId: "session", label: "Agent", access: caller.client },
  capabilities: new Set([
    "memory",
    "preview",
    "orchestration",
    "worktree",
    "device",
    "pull-requests",
  ]),
  issuedAt: 0,
});

/** One request: the caller's invocation scope and MCP client, as the auth middleware provides them. */
const asCaller =
  (scope: McpInvocationScope) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpServerClient, client),
    );

const textOf = (result: McpSchema.CallToolResult) =>
  result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

const viaCall = (server: McpServer.McpServer["Service"], path: string, args: object) =>
  server.callTool({ name: "goat_call", arguments: { path, args } }).pipe(
    Effect.map((result) => {
      expect(result.isError, path).toBe(false);
      return result.structuredContent as AgentSurfaceResult;
    }),
  );

it("resolves paths, canonical names and legacy names to one entry without collisions", () => {
  const owners = new Map<string, string>();
  for (const entry of entries)
    for (const name of [entry.path, canonicalToolName(entry), ...entry.legacyNames]) {
      expect(owners.get(name) ?? entry.path, name).toBe(entry.path);
      owners.set(name, entry.path);
      expect(resolveAgentSurfaceEntry(name)?.path).toBe(entry.path);
    }
  expect(resolveAgentSurfaceEntry("orchestrator_capabilities")?.path).toBe("provider.list");
  expect(resolveAgentSurfaceEntry("goat_provider_list")?.path).toBe("provider.list");
  expect(resolveAgentSurfaceEntry("goat_permission_profile_sync")?.name).toBe("goat_goatclaw_sync");
});

it.effect("keeps canonical aliases out of tools/list and passes served names through", () =>
  Effect.gen(function* () {
    const http = yield* serveCatalogOverHttp(callers);
    const listed = yield* http.listToolNames("thread");
    expect(listed.toSorted()).toEqual(entries.map((entry) => entry.name).sort());
    // A call by a served name, legacy ones included, reaches the server exactly as sent.
    for (const name of listed) {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name },
      });
      expect(servedToolCallBody(body), name).toBeUndefined();
    }
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("goat_call returns ok values and refuses unknown or recursive paths", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const run = asCaller(callerScope({ thread: true }));
    const described = yield* run(viaCall(server, "goat_describe", {}));
    expect(described).toMatchObject({ status: "ok", value: { depth: "surface" } });
    expect(yield* run(viaCall(server, "thread.teleport", {}))).toMatchObject({
      status: "error",
      error: { code: "not_found", reason: "unknown_path" },
    });
    expect(yield* run(viaCall(server, "surface.call", { path: "surface.describe" }))).toMatchObject(
      { status: "error", error: { code: "invalid_request", reason: "not_callable" } },
    );
  }).pipe(Effect.provide(registered)),
);

it.effect("goat_describe answers at three depths with availability for this caller", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const describe = (scope: McpInvocationScope, path?: string) =>
      asCaller(scope)(
        server
          .callTool({ name: "goat_describe", arguments: path === undefined ? {} : { path } })
          .pipe(Effect.map((result) => result.structuredContent as Record<string, unknown>)),
      );
    const thread = callerScope({ thread: true });
    const outside = callerScope({ client: "full-access" });
    const readOnly = callerScope({ client: "read-only" });

    const surface = yield* describe(thread);
    const resources = (
      surface.resources as ReadonlyArray<{ resource: string; verbs: string[] }>
    ).map(({ resource }) => resource);
    expect(resources).toEqual([...new Set(entries.map((entry) => entry.resource))].sort());

    const threadResource = yield* describe(thread, "thread");
    expect(
      (threadResource.entries as ReadonlyArray<{ path: string }>).every(({ path }) =>
        path.startsWith("thread."),
      ),
    ).toBe(true);

    const threadOnly = entries.find((entry) => entry.requires === "thread")!;
    const detail = (scope: McpInvocationScope, path: string) =>
      describe(scope, path).pipe(
        Effect.map((result) => result.entry as { available: unknown; inputSchema: unknown }),
      );
    expect((yield* detail(thread, threadOnly.path)).available).toEqual({ now: true });
    expect((yield* detail(outside, threadOnly.name)).available).toEqual({
      now: false,
      reason: "Needs an agent running inside a GOAT thread.",
    });
    const write = entries.find((entry) => entry.effect !== "read" && entry.requires === "either")!;
    expect((yield* detail(readOnly, write.path)).available).toEqual({
      now: false,
      reason: "This MCP client was approved for read-only access.",
    });
    expect((yield* detail(readOnly, "goat_call")).available).toEqual({ now: true });
    expect((yield* detail(thread, "thread.send")).inputSchema).toMatchObject({ type: "object" });

    const missing = yield* asCaller(thread)(
      server.callTool({ name: "goat_describe", arguments: { path: "teleport" } }),
    );
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("no resource or path named teleport");
  }).pipe(Effect.provide(registered)),
);

const SECRET = "SECRET-planted-7c1f";
const decodeDeviceSession = Schema.decodeUnknownSync(DeviceSession);
const failingDevice = Layer.mock(DeviceService.DeviceService)({
  sessionsForThread: (threadId) =>
    Effect.succeed([
      decodeDeviceSession({
        threadId,
        hostId: "local",
        deviceId: "device-1",
        platform: "ios",
        openedAt: "2026-10-23T00:00:00.000Z",
      }),
    ]),
  screenshot: () =>
    Effect.fail(new DeviceHostUnavailableError({ hostId: "local", reason: SECRET })),
});
const registeredWithFailingDevice = catalog.pipe(
  Layer.provide(Layer.mergeAll(dependencies, failingDevice)),
  Layer.provideMerge(McpServer.McpServer.layer),
);

it.effect("goat_call never shows failure text a direct call hides", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const run = asCaller(callerScope({ thread: true }));
    const direct = yield* run(server.callTool({ name: "device_screenshot", arguments: {} }));
    expect(direct.isError).toBe(true);
    expect(JSON.stringify(direct)).not.toContain(SECRET);
    const envelope = yield* run(viaCall(server, "device.screenshot", {}));
    expect(JSON.stringify(envelope)).not.toContain(SECRET);
    // The declared tag still classifies it; the text is what the direct call shows.
    expect(envelope).toMatchObject({
      status: "error",
      error: {
        code: "unavailable",
        reason: "DeviceHostUnavailableError",
        message: textOf(direct),
        retryable: true,
      },
    });
  }).pipe(Effect.provide(registeredWithFailingDevice)),
);

it("gives goat_describe and goat_call a tool presentation", () => {
  for (const entry of [
    agentSurfaceRegistry["surface.describe"],
    agentSurfaceRegistry["surface.call"],
  ]) {
    expect(
      resolveGoatMcpToolDefinition(entry.name)?.summaryAction ?? null,
      entry.name,
    ).not.toBeNull();
    expect(resolveGoatMcpToolPresentation(`mcp__t3-code__${entry.name}`)?.logo, entry.name).toBe(
      "t3-code",
    );
  }
});

it("presents a call by canonical name as the tool it ran", () => {
  const presented = [...canonicalToolAliases].filter(
    ([, served]) => resolveGoatMcpToolDefinition(served) !== null,
  );
  expect(GOAT_MCP_CANONICAL_TOOL_ALIASES).toEqual(Object.fromEntries(presented));
  for (const [canonical, served] of canonicalToolAliases)
    expect(resolveGoatMcpToolDefinition(`mcp__goat__${canonical}`), canonical).toBe(
      resolveGoatMcpToolDefinition(served),
    );
});
