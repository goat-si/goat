/** MCP routing regressions through the real OpenCode 2 HTTP client. */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type ProviderReplayEntry,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import { OPENCODE_PROVIDER, cuaMcpServerName, goatMcpServerName } from "../testing.ts";
import { openCode2ReplayRuntime } from "../../../../apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.testkit.ts";
const SESSION = "ses_f148ca2deffeJcwCnRQtb0YFNX";
const WORK = "/work/opencode2";
const instanceId = ProviderInstanceId.make("opencode");
const threadId = ThreadId.make("thread:opencode2-adapter");

const out = (type: string, input?: unknown): ProviderReplayEntry => ({
  type: "expect_outbound",
  frame: input === undefined ? { type } : { type, input },
});
/** A recorded response body; `{ data }` is the server's envelope, `null` an empty 204. */
const reply = (operation: string, data: unknown): ProviderReplayEntry => ({
  type: "emit_inbound",
  frame: { type: "sdk.response", operation, data },
});
const replyData = (operation: string, data: unknown) => reply(operation, { data });
const event = (
  type: string,
  data: Record<string, unknown>,
  /** Holds the event until a test's replay gate releases this label. */
  label?: string,
): ProviderReplayEntry => ({
  type: "emit_inbound",
  frame: {
    type: "sdk.event",
    event: { id: `evt_${type.replaceAll(".", "")}0000`, created: 1, type, data, ...durable },
  },
  ...(label === undefined ? {} : { label }),
});
const durable = { durable: { aggregateID: SESSION, seq: 1, version: 1 } };

/**
 * The rules GOAT gives every session it runs: only this thread's own GOAT server is allowed,
 * and every managed Cua Driver is denied whether or not this thread has one.
 */
const mcpRules = [
  { action: "t3-code-*", resource: "*", effect: "deny" },
  { action: "goat-*", resource: "*", effect: "deny" },
  { action: "goat-c26f2f1fb6fbbcc2_*", resource: "*", effect: "allow" },
  { action: "cua-driver-*", resource: "*", effect: "deny" },
];
const goatRules = [{ action: "*", resource: "*", effect: "allow" }, ...mcpRules];
/** The thread's title, which the recorded session already carries. */
const TITLE = "Prime check";
const sessionInfo = (overrides: Record<string, unknown> = {}) => ({
  id: SESSION,
  title: TITLE,
  permissions: goatRules,
  projectID: "global",
  model: { id: "big-pickle", providerID: "opencode", variant: "default" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1790656601394, updated: 1790656601394 },
  location: { directory: WORK },
  ...overrides,
});
// `/api/model` as 2.0.18 lists big-pickle: its 160k input limit is the usable window.
const modelCatalog = {
  location: { directory: WORK },
  data: [
    {
      id: "big-pickle",
      modelID: "big-pickle",
      providerID: "opencode",
      family: "big-pickle",
      name: "Big Pickle",
      compatibility: { reasoningField: "reasoning_content" },
      package: "@opencode/ai/providers/openai-compatible",
      settings: { apiKey: "public", baseURL: "https://opencode.ai/zen/v1", provider: "opencode" },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      variants: [],
      time: { released: 1760659200000 },
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      status: "active",
      enabled: true,
      limit: { context: 200000, input: 160000, output: 32000 },
    },
  ],
};

/** The prompt id the recorded answer carries; a replay maps it to the one T3 chose. */
const PROMPT_ID = "msg_0eb735d41001NJee1EvVePJAK5";
const promptAccepted = replyData("session.prompt", {
  id: PROMPT_ID,
  sessionID: SESSION,
  time: { created: 1790656601410 },
  type: "user",
  payload: { text: "hi" },
  delivery: "steer",
});

/** A resumed session that waits on nothing. */
const noOpenRequests: ReadonlyArray<ProviderReplayEntry> = [
  out("permission.list", { sessionID: SESSION }),
  replyData("permission.list", []),
  out("session.form.list", { sessionID: SESSION }),
  replyData("session.form.list", []),
];

/** What every session sends when it opens: the event stream, then the model list. */
const opening: ReadonlyArray<ProviderReplayEntry> = [
  out("event.subscribe"),
  out("model.list", "<any>"),
  reply("model.list", modelCatalog),
];
const bigPickle: ModelSelection = { instanceId, model: "opencode/big-pickle" };
const policy = (runtimeMode: "full-access" | "approval-required" = "full-access") => ({
  runtimeMode,
  interactionMode: "default" as const,
  cwd: WORK,
});

const providerThread = (now: DateTime.Utc): OrchestrationV2ProviderThread => ({
  id: ProviderThreadId.make("provider-thread:opencode2-adapter"),
  driver: OPENCODE_PROVIDER,
  providerInstanceId: instanceId,
  providerSessionId: ProviderSessionId.make("provider-session:opencode2-adapter"),
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: { driver: OPENCODE_PROVIDER, nativeId: SESSION, strength: "strong" },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
});

const turnInput = (
  thread: OrchestrationV2ProviderThread,
  modelSelection: ModelSelection = bigPickle,
  runtimeMode: "full-access" | "approval-required" = "full-access",
) => ({
  appThread: { title: TITLE } as OrchestrationV2AppThread,
  threadId,
  runId: RunId.make("run:opencode2-adapter"),
  runOrdinal: 1,
  providerTurnOrdinal: 1,
  attemptId: RunAttemptId.make("attempt:opencode2-adapter"),
  rootNodeId: NodeId.make("node:opencode2-adapter"),
  providerThread: thread,
  message: {
    messageId: MessageId.make("message:opencode2-adapter"),
    text: "hi",
    attachments: [],
    createdBy: "user" as const,
    creationSource: "web" as const,
    scheduledTaskId: undefined,
    senderThreadId: undefined,
  },
  modelSelection,
  runtimePolicy: policy(runtimeMode),
});

const terminalOf = (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime) =>
  runtime.events.pipe(
    Stream.filter(
      (
        event,
      ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
        event.type === "turn.terminal",
    ),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

it.layer(McpProviderSessions.layer)("OpenCode v2 MCP routing", (it) => {
  it.effect.each([false, true])(
    "WP4 C-2 reinstalls changed endpoint and fences failed replacement=%s",
    (failReplacement) =>
      Effect.gen(function* () {
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* Effect.addFinalizer(() => sessions.clear(threadId));
        const config = {
          environmentId: EnvironmentId.make("fixture"),
          threadId,
          providerSessionId: "provider-session:opencode2-adapter",
          providerInstanceId: instanceId,
          endpoint: "http://fixture.invalid/a",
          authorizationHeader: "Bearer synthetic-routing",
          browserToolsAvailable: false,
          grantedScopes: ["memory:read", "memory:write", "orchestration:read"] as const,
        };
        const name = yield* goatMcpServerName(threadId).pipe(Effect.provide(NodeCrypto.layer));
        const add = (endpoint: string) =>
          out("mcp.add", {
            server: name,
            config: {
              type: "remote",
              url: endpoint,
              headers: { Authorization: config.authorizationHeader },
              oauth: false,
            },
          });
        const remove = () => out("mcp.remove", { server: name, "location[directory]": WORK });
        const instructions = [
          out("session.instructions.entry.put", {
            sessionID: SESSION,
            key: "goat",
            value: "<any>",
          }),
          reply("session.instructions.entry.put", null),
        ];
        const prompt = [
          out("session.prompt", { sessionID: SESSION, text: "hi" }),
          promptAccepted,
          event("session.execution.succeeded", { sessionID: SESSION }),
        ];
        const entries = [
          ...opening,
          out("session.get", { sessionID: SESSION }),
          replyData("session.get", sessionInfo()),
          ...noOpenRequests,
          add(config.endpoint),
          reply("mcp.add", null),
          ...instructions,
          ...prompt,
          remove(),
          reply("mcp.remove", null),
          add("http://fixture.invalid/b"),
          reply(
            "mcp.add",
            failReplacement ? { status: 500, body: { error: "replacement failed" } } : null,
          ),
          ...(failReplacement ? instructions : []),
          ...prompt,
          ...(failReplacement ? [] : [remove(), reply("mcp.remove", null)]),
        ];
        const systems: string[] = [];
        const runtime = yield* openCode2ReplayRuntime(entries, {
          onInstructions: (key, value) => {
            if (key === "goat") systems.push(value);
          },
        });
        const thread = yield* runtime.resumeThread({
          providerThread: providerThread(yield* DateTime.now),
          threadId,
          modelSelection: bigPickle,
          runtimePolicy: policy(),
        });
        for (let index = 0; index < 2; index++) {
          yield* sessions.set({
            ...config,
            endpoint: index === 0 ? config.endpoint : "http://fixture.invalid/b",
          });
          const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
          yield* runtime.startTurn({
            ...turnInput(thread),
            providerTurnOrdinal: index + 1,
            runOrdinal: index + 1,
          });
          assert.equal((yield* Fiber.join(terminal))?.status, "completed");
          const available = index === 0 || !failReplacement;
          if (available) {
            assert.include(systems.at(-1) ?? "", "read=true, write=true, source=true");
          } else {
            // The instruction replaces its prior value; no conversational correction is needed.
            assert.notInclude(systems.at(-1) ?? "", "GOAT memory tools:");
          }
        }
        yield* runtime.unloadThread!({ providerThread: thread });
      }).pipe(Effect.scoped),
  );
  it.effect("registers the thread's Cua Driver per directory and removes it when detached", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* Effect.addFinalizer(() => sessions.clear(threadId));
      const cuaDriver = {
        command: "/resources/cua-driver",
        args: ["mcp"],
        environment: [{ name: "CUA_DRIVER_RS_TELEMETRY_ENABLED", value: "false" }],
      };
      const config = {
        environmentId: EnvironmentId.make("fixture"),
        threadId,
        providerSessionId: "provider-session:opencode2-adapter",
        providerInstanceId: instanceId,
        endpoint: "http://fixture.invalid/a",
        authorizationHeader: "Bearer synthetic-routing",
        browserToolsAvailable: false,
      };
      const name = yield* goatMcpServerName(threadId).pipe(Effect.provide(NodeCrypto.layer));
      const cuaName = yield* cuaMcpServerName(threadId).pipe(Effect.provide(NodeCrypto.layer));
      assert.equal(cuaName, "cua-driver-c26f2f1fb6fbbcc2");
      const addGoat = [
        out("mcp.add", {
          server: name,
          config: {
            type: "remote",
            url: config.endpoint,
            headers: { Authorization: config.authorizationHeader },
            oauth: false,
          },
        }),
        reply("mcp.add", null),
      ];
      const instructions = [
        out("session.instructions.entry.put", { sessionID: SESSION, key: "goat", value: "<any>" }),
        reply("session.instructions.entry.put", null),
      ];
      const prompt = [
        out("session.prompt", { sessionID: SESSION, text: "hi" }),
        promptAccepted,
        event("session.execution.succeeded", { sessionID: SESSION }),
      ];
      // Every turn denies all managed drivers; only a turn with the driver allows its own, so an
      // excluded turn (Plan, read-only) cannot reach a driver another thread registered here.
      const rules = (computerUse: boolean) => [
        out("session.update", {
          sessionID: SESSION,
          permissions: computerUse
            ? [...goatRules, { action: `${cuaName}_*`, resource: "*", effect: "allow" }]
            : goatRules,
        }),
        reply("session.update", null),
      ];
      const entries = [
        ...opening,
        out("session.get", { sessionID: SESSION }),
        replyData("session.get", sessionInfo()),
        ...noOpenRequests,
        ...rules(true),
        ...addGoat,
        out("mcp.add", {
          server: cuaName,
          config: {
            type: "local",
            command: ["/resources/cua-driver", "mcp"],
            environment: { CUA_DRIVER_RS_TELEMETRY_ENABLED: "false" },
          },
        }),
        reply("mcp.add", null),
        ...instructions,
        ...prompt,
        ...rules(false),
        ...addGoat,
        out("mcp.remove", { server: cuaName, "location[directory]": WORK }),
        reply("mcp.remove", null),
        ...instructions,
        ...prompt,
        out("mcp.remove", { server: name, "location[directory]": WORK }),
        reply("mcp.remove", null),
      ];
      const systems: string[] = [];
      const runtime = yield* openCode2ReplayRuntime(entries, {
        onInstructions: (key, value) => {
          if (key === "goat") systems.push(value);
        },
      });
      const thread = yield* runtime.resumeThread({
        providerThread: providerThread(yield* DateTime.now),
        threadId,
        modelSelection: bigPickle,
        runtimePolicy: policy(),
      });
      for (const [index, attachment] of [{ ...config, cuaDriver }, config].entries()) {
        yield* sessions.set(attachment);
        const terminal = yield* terminalOf(runtime).pipe(Effect.forkScoped);
        yield* runtime.startTurn({
          ...turnInput(thread),
          providerTurnOrdinal: index + 1,
          runOrdinal: index + 1,
        });
        assert.equal((yield* Fiber.join(terminal))?.status, "completed");
        assert.equal((systems.at(-1) ?? "").includes("<computer_use>"), index === 0);
      }
      yield* runtime.unloadThread!({ providerThread: thread });
    }).pipe(Effect.scoped),
  );
});
