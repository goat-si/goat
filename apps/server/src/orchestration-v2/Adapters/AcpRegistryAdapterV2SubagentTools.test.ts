import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  RunAttemptId,
  RunId,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@goat/contracts";
import { resolveSelfInvocation } from "@goat/shared/nodeRuntime";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import type { ProviderReplayGate } from "@goat/provider-testing/replayGate";
import type { ProviderContinuationRequest } from "@goat/provider-core/server/ProviderContinuationRequests";
import * as ServerSettings from "../../serverSettings.ts";
import * as AcpRegistrySupport from "@goat/provider-acp-registry/server/AcpRegistrySupport";
import * as AcpSessionRuntime from "@goat/provider-acp/server/AcpSessionRuntime";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";

import { decodeAcpReplayTranscript, makeAcpReplayRuntime } from "./AcpAdapterV2.testkit.ts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { AcpRegistryAdapterV2Driver } from "@goat/provider-acp-registry/server";

const decodeAcpRegistryAdapterSettings = Schema.decodeUnknownEffect(
  AcpRegistryAdapterV2Driver.configSchema,
);
import {
  ACP_REGISTRY_PROVIDER,
  makeAcpRegistryAdapterV2,
} from "@goat/provider-acp-registry/testing";

const layerHost = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));

const layerRegistry = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          version: "1.0.0",
          agents: [
            {
              id: "fixture-agent",
              name: "Fixture Agent",
              version: "1.0.0",
              description: "ACP V2 adapter fixture",
              distribution: {
                binary: {
                  "darwin-aarch64": {
                    archive: "https://registry.test/unused",
                    cmd: "fixture-agent",
                    args: [],
                  },
                  "linux-x86_64": {
                    archive: "https://registry.test/unused",
                    cmd: "fixture-agent",
                    args: [],
                  },
                },
              },
            },
          ],
        }),
      ),
    ),
  ),
);

const layerInjectedRuntimeCatalog = Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
  resolve: () => Effect.die("the runtime is injected"),
});

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  layerHost,
  layerRegistry,
  ServerSettings.layerTest(),
);

const CLAUDE_ROOT_SESSION = "claude-session";

/** Replay frames of Claude Agent (claude-agent-acp 0.90.0) on ACP v2. */
const claudeFrames = {
  open: [
    { type: "expect_outbound", frame: { kind: "request", method: "initialize", params: "<any>" } },
    {
      type: "emit_inbound",
      frame: {
        kind: "response",
        method: "initialize",
        result: {
          protocolVersion: 2,
          info: { name: "@agentclientprotocol/claude-agent-acp", version: "0.90.0" },
          capabilities: { session: {} },
          authMethods: [],
        },
      },
    },
    { type: "expect_outbound", frame: { kind: "request", method: "session/new", params: "<any>" } },
    {
      type: "emit_inbound",
      frame: {
        kind: "response",
        method: "session/new",
        result: { sessionId: CLAUDE_ROOT_SESSION },
      },
    },
  ],
  update: (sessionId: string, sessionUpdate: Record<string, unknown>) => ({
    type: "emit_inbound",
    frame: {
      kind: "notification",
      method: "session/update",
      params: { sessionId, update: sessionUpdate },
    },
  }),
  childState: (parent: string, child: string, state: string) =>
    claudeFrames.update(parent, {
      sessionUpdate: "subagent_update",
      sessionId: child,
      state: { state },
    }),
  /** A prompt Claude takes in and works on. */
  prompt: (ordinal: number) => [
    {
      type: "expect_outbound",
      frame: { kind: "request", method: "session/prompt", params: "<any>" },
    },
    claudeFrames.update(CLAUDE_ROOT_SESSION, {
      sessionUpdate: "user_message",
      messageId: `user-${ordinal}`,
      content: [{ type: "text", text: "test prompt" }],
    }),
    {
      type: "emit_inbound",
      frame: {
        kind: "response",
        method: "session/prompt",
        result: { messageId: `user-${ordinal}` },
      },
    },
    claudeFrames.update(CLAUDE_ROOT_SESSION, { sessionUpdate: "state_update", state: "running" }),
  ],
  idle: (stopReason: string) =>
    claudeFrames.update(CLAUDE_ROOT_SESSION, {
      sessionUpdate: "state_update",
      state: "idle",
      stopReason,
    }),
  closeRequest: {
    type: "expect_outbound",
    frame: {
      kind: "request",
      method: "session/close",
      params: { sessionId: CLAUDE_ROOT_SESSION },
    },
  },
  closed: {
    type: "emit_inbound",
    frame: { kind: "response", method: "session/close", result: {} },
  },
};

const openClaudeReplaySession = Effect.fn("openClaudeReplaySession")(function* (
  entries: ReadonlyArray<unknown>,
  replayGate?: ProviderReplayGate,
  continuationEnabled = true,
  agentId = "claude-acp",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const replayDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-claude-lifecycle-" });
  const transcript = yield* decodeAcpReplayTranscript(
    {
      provider: ACP_REGISTRY_PROVIDER,
      protocol: "acp.ndjson-jsonrpc",
      version: "1",
      scenario: "claude-lifecycle",
      entries: entries as never,
    },
    ACP_REGISTRY_PROVIDER,
  );
  const offers: Array<ProviderContinuationRequest> = [];
  const offered = yield* Queue.unbounded<void>();
  const continuationRequests = {
    offer: (request: ProviderContinuationRequest) =>
      Effect.sync(() => {
        offers.push(request);
      }).pipe(Effect.andThen(Queue.offer(offered, undefined)), Effect.asVoid),
  };
  const instanceId = ProviderInstanceId.make("claude-lifecycle");
  let onTermination: NonNullable<
    AcpSessionRuntime.AcpSessionRuntimeOptions["onTermination"]
  > = () => Effect.die("Runtime has not started");
  const replayRuntime = makeAcpReplayRuntime({
    transcript,
    statusPath: path.join(replayDir, "status.json"),
    scriptPath: yield* path.fromFileUrl(
      new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
    ),
    childProcessSpawner,
    fileSystem,
    ...(replayGate === undefined ? {} : { replayGate }),
  });
  const adapterOptions = {
    selfInvocation: yield* resolveSelfInvocation(),
    instanceId,
    settings: yield* decodeAcpRegistryAdapterSettings({ agentId }),
    environment: {},
    ...(continuationEnabled ? { continuationRequests } : {}),
    makeRuntime: (runtimeInput: Parameters<typeof replayRuntime>[0]) => {
      onTermination = runtimeInput.onTermination;
      return replayRuntime(runtimeInput);
    },
  };
  const adapter = yield* makeAcpRegistryAdapterV2(adapterOptions).pipe(
    Effect.provide(layerInjectedRuntimeCatalog),
  );
  const threadId = ThreadId.make("thread-claude-lifecycle");
  const modelSelection = { instanceId, model: "default" } as const;
  const runtimeMode = "approval-required";
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: replayDir,
  });
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("session-claude-lifecycle"),
    modelSelection,
    runtimePolicy,
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => replayGate?.releaseAll()));
  if (continuationEnabled) {
    assert.isDefined(
      runtime.hasPendingBackgroundWork,
      "Claude ACP v2 must report background work after foreground idle",
    );
  }
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const now = yield* DateTime.now;
  const turnInput = (
    ordinal: number,
    options: { readonly continuation?: boolean } = {},
  ): ProviderAdapter.ProviderAdapterV2TurnInput => ({
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make(`project-claude-lifecycle`),
      title: "Claude Agent",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId,
    runId: RunId.make(`run-claude-lifecycle-${ordinal}`),
    runOrdinal: ordinal,
    providerTurnOrdinal: ordinal,
    attemptId: RunAttemptId.make(`attempt-claude-lifecycle-${ordinal}`),
    rootNodeId: NodeId.make(`node-claude-lifecycle-${ordinal}`),
    providerThread,
    message: {
      ...(options.continuation === true
        ? { createdBy: "agent" as const, creationSource: "provider" as const }
        : { createdBy: "user" as const, creationSource: "web" as const }),
      messageId: MessageId.make(`message-claude-lifecycle-${ordinal}`),
      text: "test prompt",
      attachments: [],
    },
    modelSelection,
    runtimePolicy,
  });
  const until = (predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
    Effect.gen(function* () {
      const seen: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      while (true) {
        const event = yield* Queue.take(events);
        seen.push(event);
        if (predicate(event)) return seen;
      }
    });
  const throughMarker = (title: string) =>
    until(
      (event) =>
        event.type === "provider_thread.updated" &&
        event.providerThread.nativeMetadata?.title === title,
    );
  const terminal = until((event) => event.type === "turn.terminal").pipe(
    Effect.map((seen) => {
      const event = seen.at(-1)!;
      if (event.type !== "turn.terminal") throw new Error("Missing terminal");
      return event;
    }),
  );
  return {
    runtime,
    providerThread,
    turnInput,
    until,
    throughMarker,
    terminal,
    offers,
    offered,
    terminate: () =>
      onTermination(
        new EffectAcpErrors.AcpTransportError({
          detail: "Injected fixture process exit",
          cause: "test",
        }),
      ),
  };
});

const claudeMarker = (title: string) =>
  claudeFrames.update(CLAUDE_ROOT_SESSION, {
    sessionUpdate: "session_info_update",
    title,
  });
const claudeChild = [
  claudeFrames.update(CLAUDE_ROOT_SESSION, {
    sessionUpdate: "tool_call_update",
    toolCallId: "agent-1",
    name: "Agent",
    title: "Review",
    kind: "think",
    status: "in_progress",
    rawInput: { prompt: "Review the code", description: "Review", run_in_background: true },
  }),
  claudeFrames.childState(CLAUDE_ROOT_SESSION, "child-1", "running"),
  claudeFrames.update("child-1", {
    sessionUpdate: "session_message",
    messageId: "agent-1",
    senderSessionId: CLAUDE_ROOT_SESSION,
    recipientSessionId: "child-1",
    content: [{ type: "text", text: "Review the code" }],
  }),
  claudeFrames.update(CLAUDE_ROOT_SESSION, {
    sessionUpdate: "tool_call_update",
    toolCallId: "agent-1",
    status: "completed",
    _meta: { claudeCode: { toolResponse: { isAsync: true } } },
  }),
];

describe("AcpRegistryAdapterV2SubagentTools", () => {
  it.effect("retains streamed child tool output through the generic Devin route", () =>
    Effect.gen(function* () {
      const { update } = claudeFrames;
      const session = yield* openClaudeReplaySession(
        [
          ...claudeFrames.open,
          ...claudeFrames.prompt(1),
          update("child-1", {
            sessionUpdate: "tool_call_update",
            toolCallId: "early-tool",
            status: "in_progress",
            rawInput: { command: "echo early" },
          }),
          update("child-1", {
            sessionUpdate: "tool_call_content_chunk",
            toolCallId: "early-tool",
            content: { type: "content", content: { type: "text", text: "early" } },
          }),
          update("child-1", {
            sessionUpdate: "tool_call_update",
            toolCallId: "early-tool",
            status: "completed",
          }),
          update(CLAUDE_ROOT_SESSION, {
            sessionUpdate: "tool_call_update",
            toolCallId: "spawn",
            status: "in_progress",
            _meta: { "cognition.ai/subagent_started": { agentId: "child-1", task: "Review" } },
          }),
          ...[CLAUDE_ROOT_SESSION, "child-1"].map((sessionId) =>
            update(sessionId, {
              sessionUpdate: "tool_call_update",
              toolCallId: "shared-tool",
              title: "Read package",
              kind: "execute",
              status: "in_progress",
              rawInput: { command: "cat package.json" },
              ...(sessionId === "child-1"
                ? { content: [{ type: "content", content: { type: "text", text: "one" } }] }
                : {}),
            }),
          ),
          update("child-1", {
            sessionUpdate: "tool_call_content_chunk",
            toolCallId: "shared-tool",
            content: { type: "content", content: { type: "text", text: "two" } },
          }),
          update("child-1", {
            sessionUpdate: "tool_call_update",
            toolCallId: "shared-tool",
            status: "completed",
          }),
          update("child-1", {
            sessionUpdate: "tool_call_update",
            toolCallId: "shared-tool",
            content: [{ type: "content", content: { type: "text", text: "replacement" } }],
          }),
          update("child-1", {
            sessionUpdate: "tool_call_update",
            toolCallId: "shared-tool",
            content: [],
          }),
          update("child-1", {
            sessionUpdate: "tool_call_update",
            toolCallId: "shared-tool",
            rawOutput: { stdout: "structured", stderr: "" },
          }),
          update("child-1", {
            sessionUpdate: "tool_call_update",
            toolCallId: "shared-tool",
            content: [{ type: "content", content: { type: "text", text: "display" } }],
          }),
          update("child-1", {
            sessionUpdate: "tool_call_update",
            toolCallId: "shared-tool",
            rawOutput: { type: "Text", text: "vendor" },
          }),
          update("child-1", {
            sessionUpdate: "tool_call_update",
            toolCallId: "shared-tool",
            content: [{ type: "content", content: { type: "text", text: "display" } }],
          }),
          claudeMarker("tools complete"),
          claudeFrames.idle("end_turn"),
          claudeFrames.closeRequest,
          claudeFrames.closed,
        ],
        undefined,
        false,
        "devin",
      );
      yield* session.runtime.startTurn(session.turnInput(1));
      const events = yield* session.throughMarker("tools complete");
      const child = events.find((event) => event.type === "subagent.updated");
      if (child?.type !== "subagent.updated") throw new Error("Missing child");
      const tools = events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
          ? [event.turnItem]
          : [],
      );
      const childTools = tools.filter((item) => item.threadId === child.subagent.childThreadId);
      assert.deepEqual(
        childTools.map((item) => item.output),
        [
          [{ type: "content", content: { type: "text", text: "one" } }],
          [{ type: "content", content: { type: "text", text: "onetwo" } }],
          [{ type: "content", content: { type: "text", text: "onetwo" } }],
          [{ type: "content", content: { type: "text", text: "replacement" } }],
          [],
          { stdout: "structured", stderr: "" },
          { stdout: "structured", stderr: "" },
          { type: "Text", text: "vendor" },
          { type: "Text", text: "vendor" },
        ],
      );
      assert.equal(new Set(childTools.map((item) => item.id)).size, 1);
      assert.equal(childTools.at(-1)?.nativeItemRef?.nativeId, "child-1:tool:shared-tool");
      assert.equal(childTools.at(-1)?.status, "completed");
      assert.deepEqual(childTools.at(-1)?.input, { command: "cat package.json" });
      const parentTools = events.flatMap((event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "command_execution" &&
        event.turnItem.threadId === session.turnInput(1).threadId &&
        event.turnItem.nativeItemRef?.nativeId === "shared-tool"
          ? [event.turnItem]
          : [],
      );
      assert.lengthOf(parentTools, 1);
      assert.isUndefined(parentTools[0]?.output);
      assert.isFalse(
        events.some(
          (event) => event.type === "message.updated" && event.message.text.includes("onetwo"),
        ),
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("keeps stopped child tools interrupted when a late output chunk arrives", () =>
    Effect.gen(function* () {
      const { update } = claudeFrames;
      const session = yield* openClaudeReplaySession(
        [
          ...claudeFrames.open.map((entry) =>
            entry.frame.method === "initialize" && entry.type === "emit_inbound"
              ? {
                  ...entry,
                  frame: {
                    ...entry.frame,
                    result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
                  },
                }
              : entry,
          ),
          {
            type: "expect_outbound",
            frame: { kind: "request", method: "session/prompt", params: "<any>" },
          },
          update(CLAUDE_ROOT_SESSION, {
            sessionUpdate: "tool_call_update",
            toolCallId: "spawn",
            status: "in_progress",
            _meta: { "cognition.ai/subagent_started": { agentId: "child-1", task: "Review" } },
          }),
          update("child-1", {
            sessionUpdate: "tool_call_update",
            toolCallId: "stopped-tool",
            status: "in_progress",
          }),
          claudeMarker("before cancel"),
          {
            type: "expect_outbound",
            frame: {
              kind: "notification",
              method: "session/cancel",
              params: { sessionId: CLAUDE_ROOT_SESSION },
            },
          },
          update("child-1", {
            sessionUpdate: "tool_call_update",
            toolCallId: "stopped-tool",
            status: "failed",
          }),
          update("child-1", {
            sessionUpdate: "tool_call_update",
            toolCallId: "stopped-tool",
            content: [{ type: "content", content: { type: "text", text: "stopping" } }],
          }),
          update("child-1", {
            sessionUpdate: "tool_call_content_chunk",
            toolCallId: "stopped-tool",
            content: { type: "content", content: { type: "text", text: "cancelled" } },
          }),
          claudeMarker("late output"),
          update(CLAUDE_ROOT_SESSION, {
            sessionUpdate: "tool_call_update",
            toolCallId: "spawn",
            status: "failed",
            _meta: { "cognition.ai/subagent_completed": { agentId: "child-1", success: false } },
          }),
          {
            type: "emit_inbound",
            frame: {
              kind: "response",
              method: "session/prompt",
              result: { stopReason: "cancelled" },
            },
          },
          claudeFrames.closeRequest,
          claudeFrames.closed,
        ],
        undefined,
        false,
        "devin",
      );
      const starting = yield* session.runtime
        .startTurn(session.turnInput(1))
        .pipe(Effect.forkScoped);
      const started = yield* session.throughMarker("before cancel");
      const running = started.findLast((event) => event.type === "provider_turn.updated");
      if (running?.type !== "provider_turn.updated") throw new Error("Missing active turn");
      const closing = yield* session.runtime
        .interruptTurn({
          providerThread: session.providerThread,
          providerTurnId: running.providerTurn.id,
        })
        .pipe(Effect.forkScoped);
      const events = yield* session.throughMarker("late output");
      yield* Fiber.join(closing);
      yield* Fiber.join(starting);
      const tools = events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
          ? [event.turnItem]
          : [],
      );
      assert.deepEqual(
        tools.map((item) => item.status),
        ["interrupted", "interrupted", "interrupted"],
      );
      assert.deepEqual(tools.at(-1)?.output, [
        { type: "content", content: { type: "text", text: "stoppingcancelled" } },
      ]);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("keeps native child tools interrupted after idle and late output", () =>
    Effect.gen(function* () {
      const { update, childState } = claudeFrames;
      const session = yield* openClaudeReplaySession([
        ...claudeFrames.open,
        ...claudeFrames.prompt(1),
        ...claudeChild.slice(0, -1),
        update("child-1", {
          sessionUpdate: "tool_call_update",
          toolCallId: "unfinished",
          status: "in_progress",
        }),
        childState(CLAUDE_ROOT_SESSION, "child-1", "idle"),
        update("child-1", {
          sessionUpdate: "tool_call_content_chunk",
          toolCallId: "unfinished",
          content: { type: "content", content: { type: "text", text: "late" } },
        }),
        claudeMarker("late native output"),
        claudeFrames.idle("end_turn"),
        claudeFrames.closeRequest,
        claudeFrames.closed,
      ]);
      yield* session.runtime.startTurn(session.turnInput(1));
      const events = yield* session.throughMarker("late native output");
      const tools = events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool"
          ? [event.turnItem]
          : [],
      );
      assert.deepEqual(
        tools.map((tool) => tool.status),
        ["running", "interrupted", "interrupted"],
      );
      assert.deepEqual(tools.at(-1)?.output, [
        { type: "content", content: { type: "text", text: "late" } },
      ]);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
