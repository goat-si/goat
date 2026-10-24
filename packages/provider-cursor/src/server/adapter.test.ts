import type { AuthEnvironmentScope } from "@goat/contracts";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import * as Exit from "effect/Exit";
import { MemoryId, MemoryRevisionId, MemorySpaceId } from "@goat/contracts";
import { packMemoryContext, memoryContextText } from "@goat/provider-core/server/memoryContext";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { InteractionUpdate } from "@cursor/sdk";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import { CursorSettings } from "../settings.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { makeProviderFailure } from "@goat/provider-core/server/failure";
import {
  cursorMcpServers,
  cursorRuntimeAgentPolicy,
  makeCursorAgentOptions,
  makeCursorAdapterV2,
  nestedToolCallFromEnvelope,
} from "./adapter.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import { ConfigurationError } from "./sdk.ts";

const decodeCursorSettings = Schema.decodeEffect(CursorSettings);

describe("CursorAdapterV2", () => {
  it.effect.each([
    { status: "finished", model: undefined, lateModel: undefined },
    { status: "cancelled", model: "claude-opus-4-6", lateModel: undefined },
    { status: "error", model: "custom-fable", lateModel: undefined },
    { status: "finished", model: undefined, lateModel: "gpt-6-sol" },
    { status: "finished", model: "gpt-6-sol", lateModel: null },
  ] as const)(
    "projects Cursor tasks: $status, late model $lateModel",
    ({ status, model, lateModel }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspace = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "cursor-v2-lifecycle-",
        });
        const instanceId = ProviderInstanceId.make("cursor");
        const threadId = ThreadId.make("cursor-lifecycle-thread");
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        yield* mcpSessions.set({
          environmentId: EnvironmentId.make("cursor-lifecycle-environment"),
          threadId,
          providerSessionId: "cursor-lifecycle-session",
          providerInstanceId: instanceId,
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: "Bearer synthetic-cursor-token",
          browserToolsAvailable: true,
        });
        let sentWithMcpOverride = true;
        const modelSelection = { instanceId, model: "composer-2.5" };
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: workspace,
        });
        const adapter = yield* makeCursorAdapterV2({
          instanceId,
          settings: yield* decodeCursorSettings({}),
          environment: { HOME: workspace },
        }).pipe(
          Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
            assertComplete: Effect.void,
            open: () =>
              Effect.succeed({
                agentId: "native-cursor-lifecycle",
                listMessages: Effect.succeed([]),
                close: Effect.void,
                send: (input) =>
                  Effect.gen(function* () {
                    assert.notInclude(
                      typeof input.message === "string" ? input.message : input.message.text,
                      "GOAT memory tools:",
                    );
                    sentWithMcpOverride = Object.hasOwn(input.options ?? {}, "mcpServers");
                    // Recorded Cursor task calls (see fixtures/subagent) stream a
                    // partial-tool-call before tool-call-started with the same args.
                    // The run then ends without tool-call-completed, which a live
                    // run cannot produce on demand.
                    const taskToolCall = {
                      type: "task" as const,
                      args: {
                        description: "Review",
                        prompt: "Review the code.",
                        subagentType: { kind: "unspecified" },
                        ...(model === undefined ? {} : { model }),
                        agentId: "cursor-task-agent",
                        mode: "unspecified" as const,
                      },
                    };
                    const updates =
                      lateModel !== undefined
                        ? (["tool-call-started", "tool-call-completed"] as const)
                        : (["partial-tool-call", "tool-call-started"] as const);
                    for (const type of updates) {
                      yield* input.onDelta!({
                        type,
                        modelCallId: "model-call",
                        callId: "task-call",
                        toolCall: {
                          ...taskToolCall,
                          args: {
                            ...taskToolCall.args,
                            ...(type === "tool-call-completed"
                              ? { model: lateModel ?? undefined }
                              : {}),
                          },
                        },
                      }).pipe(Effect.orDie);
                    }
                    return {
                      agentId: "native-cursor-lifecycle",
                      runId: "native-cursor-run",
                      wait: Effect.succeed({
                        id: "native-cursor-run",
                        requestId: "native-request",
                        status,
                        model: { id: "composer-2.5" },
                        durationMs: 1,
                      }),
                      cancel: Effect.void,
                    };
                  }),
              }),
          }),
          Effect.provide(TestProviderHost.layer({ cwd: workspace })),
        );
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("cursor-lifecycle-session"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn({
          threadId,
          providerThread,
          modelSelection,
          runtimePolicy,
          runId: RunId.make("cursor-lifecycle-run"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("cursor-lifecycle-attempt"),
          rootNodeId: NodeId.make("cursor-lifecycle-root"),
          appThread: {
            id: threadId,
            projectId: ProjectId.make("cursor-lifecycle-project"),
            createdBy: "user",
            creationSource: "web",
            title: "Cursor lifecycle",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "full-access",
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
          message: {
            messageId: MessageId.make("cursor-lifecycle-message"),
            createdBy: "user",
            creationSource: "web",
            text: "Review the code.",
            attachments: [],
          },
        });
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        assert.isFalse(sentWithMcpOverride);
        const rows = events.filter((event) => event.type === "subagent.updated");
        assert.equal(rows[0]?.subagent.status, "running");
        assert.equal(rows[0]?.subagent.model, model ?? null);
        assert.equal(rows.at(-1)?.subagent.model, lateModel ?? model ?? null);
        assert.equal(
          rows.at(-1)?.subagent.status,
          lateModel !== undefined
            ? "completed"
            : status === "finished"
              ? "idle"
              : status === "cancelled"
                ? "cancelled"
                : "failed",
        );
        assert.isNotNull(rows.at(-1)?.subagent.completedAt);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
        ),
      ),
  );

  it.effect.each([
    {
      reason: "the error Cursor's run ended with",
      wait: Effect.succeed({
        id: "native-cursor-run",
        requestId: "native-request",
        status: "error" as const,
        error: {
          message: "Model Blocked Please ask your admin to enable access to Claude Fable 5.",
        },
        model: { id: "claude-fable-5" },
        durationMs: 1,
      }),
      failure: {
        class: "provider_error",
        message: "Model Blocked Please ask your admin to enable access to Claude Fable 5.",
      },
    },
    {
      reason: "the SDK error that broke the run",
      wait: Effect.fail(
        new CursorAgentSdk.CursorAgentSdkRunnerError({
          method: "run.wait",
          cause: Object.assign(new Error("Too many requests"), {
            code: "resource_exhausted",
            status: 429,
          }),
        }),
      ),
      failure: {
        class: "transport_error",
        message:
          "Cursor Agent SDK run.wait failed: Too many requests (resource_exhausted, HTTP 429)",
      },
    },
    {
      reason: "a transport dump sent after earlier commentary",
      updates: [
        { type: "text-delta", text: "Checking the build first." },
        { type: "step-completed", stepId: 1, stepDurationMs: 1 },
        { type: "text-delta", text: "Error: RetriableError: WritableIterable is closed" },
      ] satisfies ReadonlyArray<InteractionUpdate>,
      wait: Effect.succeed({
        id: "native-cursor-run",
        requestId: "native-request",
        status: "finished" as const,
        model: { id: "claude-fable-5" },
        durationMs: 1,
      }),
      failure: { class: "transport_error", message: "Provider turn failed." },
    },
  ])("fails the turn with $reason", ({ updates = [], wait, failure }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-v2-failure-" });
      const instanceId = ProviderInstanceId.make("cursor");
      const threadId = ThreadId.make("cursor-failure-thread");
      const modelSelection = { instanceId, model: "claude-fable-5" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const adapter = yield* makeCursorAdapterV2({
        instanceId,
        settings: yield* decodeCursorSettings({}),
        environment: { HOME: workspace },
      }).pipe(
        Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
          assertComplete: Effect.void,
          open: () =>
            Effect.succeed({
              agentId: "native-cursor-failure",
              listMessages: Effect.succeed([]),
              close: Effect.void,
              send: (input) =>
                Effect.gen(function* () {
                  for (const update of updates) {
                    yield* input.onDelta!(update).pipe(Effect.orDie);
                  }
                  return {
                    agentId: "native-cursor-failure",
                    runId: "native-cursor-run",
                    wait,
                    cancel: Effect.void,
                  };
                }),
            }),
        }),
        Effect.provide(TestProviderHost.layer({ cwd: workspace })),
      );
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-failure-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime.startTurn({
        threadId,
        providerThread,
        modelSelection,
        runtimePolicy,
        runId: RunId.make("cursor-failure-run"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("cursor-failure-attempt"),
        rootNodeId: NodeId.make("cursor-failure-root"),
        appThread: {
          id: threadId,
          projectId: ProjectId.make("cursor-failure-project"),
          createdBy: "user",
          creationSource: "web",
          title: "Cursor failure",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
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
        message: {
          messageId: MessageId.make("cursor-failure-message"),
          createdBy: "user",
          creationSource: "web",
          text: "hi",
          attachments: [],
        },
      });
      const terminal = yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
      assert.isTrue(Option.isSome(terminal));
      if (Option.isSome(terminal)) {
        assert.equal(terminal.value.status, "failed");
        assert.equal(terminal.value.failure?.class, failure.class);
        assert.equal(terminal.value.failure?.message, failure.message);
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
      ),
    ),
  );

  it.effect("fails standalone SDK transport diagnostics and sends compaction as /compress", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-v2-errors-" });
      const sentMessages: Array<string> = [];
      let sendCalls = 0;
      const instanceId = ProviderInstanceId.make("cursor");
      const threadId = ThreadId.make("cursor-transport-error-thread");
      const modelSelection = { instanceId, model: "composer-2.5" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const adapter = yield* makeCursorAdapterV2({
        instanceId,
        settings: yield* decodeCursorSettings({}),
        environment: { HOME: workspace },
      }).pipe(
        Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
          assertComplete: Effect.void,
          open: () =>
            Effect.succeed({
              agentId: "native-cursor-error",
              listMessages: Effect.succeed([]),
              close: Effect.void,
              send: (input) =>
                Effect.sync(() => {
                  sendCalls += 1;
                  sentMessages.push(
                    typeof input.message === "string" ? input.message : input.message.text,
                  );
                  const runId = `native-cursor-run-${sendCalls}`;
                  return {
                    agentId: "native-cursor-error",
                    runId,
                    wait: Effect.succeed({
                      id: runId,
                      requestId: `native-request-${sendCalls}`,
                      status: "finished" as const,
                      model: { id: "composer-2.5" },
                      durationMs: 1,
                      ...(sendCalls === 1
                        ? { result: "Error: RetriableError: WritableIterable is closed" }
                        : {}),
                    }),
                    cancel: Effect.void,
                  };
                }),
            }),
        }),
        Effect.provide(TestProviderHost.layer({ cwd: workspace })),
      );
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-error-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      const appThread = {
        id: threadId,
        projectId: ProjectId.make("cursor-error-project"),
        createdBy: "user" as const,
        creationSource: "web" as const,
        title: "Cursor transport failure",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
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
      };
      yield* runtime.startTurn({
        threadId,
        providerThread,
        modelSelection,
        runtimePolicy,
        runId: RunId.make("cursor-error-run"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("cursor-error-attempt"),
        rootNodeId: NodeId.make("cursor-error-root"),
        appThread,
        message: {
          messageId: MessageId.make("cursor-error-message"),
          createdBy: "user",
          creationSource: "web",
          text: "continue",
          attachments: [],
        },
      });
      const first = yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
      assert.isTrue(Option.isSome(first));
      if (Option.isSome(first)) {
        assert.equal(first.value.status, "failed");
        assert.equal(first.value.failure?.class, "transport_error");
      }

      assert.isDefined(runtime.compactThread);
      yield* runtime.compactThread!({
        threadId,
        providerThread,
        modelSelection,
        runtimePolicy,
        runId: RunId.make("cursor-compact-run"),
        runOrdinal: 2,
        providerTurnOrdinal: 2,
        attemptId: RunAttemptId.make("cursor-compact-attempt"),
        rootNodeId: NodeId.make("cursor-compact-root"),
        appThread,
        message: {
          messageId: MessageId.make("cursor-compact-message"),
          createdBy: "user",
          creationSource: "web",
          text: "ignored by compactThread",
          attachments: [],
        },
      });
      yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
      assert.equal(sentMessages[1], "/compress");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
      ),
    ),
  );

  it.effect("WP4 Cursor memory refresh, clear and tamper preserve native /compress", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-v2-errors-" });
      const hostContext = yield* Layer.build(TestProviderHost.layer({ cwd: workspace }));
      const host = yield* Effect.service(ProviderHost.ProviderHost).pipe(
        Effect.provide(hostContext),
      );
      yield* fileSystem.writeFileString(`${host.paths.attachmentsDir}/memory.png`, "fixture image");
      const imageCounts: number[] = [];
      const sentMessages: Array<string> = [];
      const snapshot = wp4Snapshot();
      let refreshes = 0;
      let memory: typeof snapshot | undefined = snapshot;
      let sendCalls = 0;
      const opens: CursorAgentSdk.CursorAgentSdkOpenInput[] = [];
      const connections: string[] = [];
      let closes = 0;
      const instanceId = ProviderInstanceId.make("cursor");
      const threadId = ThreadId.make("cursor-transport-error-thread");
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const config = (grantedScopes: ReadonlyArray<AuthEnvironmentScope>) => ({
        environmentId: EnvironmentId.make("fixture"),
        threadId,
        providerSessionId: "cursor-error-session",
        providerInstanceId: instanceId,
        endpoint: "http://fixture.invalid/mcp",
        authorizationHeader: "Bearer memory-fixture",
        browserToolsAvailable: false,
        grantedScopes,
      });
      yield* sessions.set(config(["memory:read", "memory:write", "orchestration:read"]));
      const modelSelection = { instanceId, model: "composer-2.5" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const adapter = yield* makeCursorAdapterV2({
        instanceId,
        settings: yield* decodeCursorSettings({}),
        environment: { HOME: workspace },
      }).pipe(
        Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
          assertComplete: Effect.void,
          open: (openInput) =>
            Effect.gen(function* () {
              opens.push(openInput);
              connections.push("open");
              return {
                agentId: "native-cursor-error",
                listMessages: Effect.succeed([]),
                close: Effect.sync(() => {
                  closes++;
                  connections.push("close");
                }),
                send: (input) =>
                  Effect.sync(() => {
                    sendCalls += 1;
                    imageCounts.push(
                      typeof input.message === "string" ? 0 : (input.message.images?.length ?? 0),
                    );
                    sentMessages.push(
                      typeof input.message === "string" ? input.message : input.message.text,
                    );
                    const runId = `native-cursor-run-${sendCalls}`;
                    return {
                      agentId: "native-cursor-error",
                      runId,
                      wait: Effect.succeed({
                        id: runId,
                        requestId: `native-request-${sendCalls}`,
                        status: "finished" as const,
                        model: { id: "composer-2.5" },
                        durationMs: 1,
                        ...(sendCalls === 1
                          ? { result: "Error: RetriableError: WritableIterable is closed" }
                          : {}),
                      }),
                      cancel: Effect.void,
                    };
                  }),
              };
            }),
        }),
        Effect.provide(hostContext),
      );
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-error-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      const appThread = {
        id: threadId,
        projectId: ProjectId.make("cursor-error-project"),
        createdBy: "user" as const,
        creationSource: "web" as const,
        title: "Cursor transport failure",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
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
      };
      const ordinaryInput: ProviderAdapter.ProviderAdapterV2TurnInput = {
        threadId,
        providerThread,
        modelSelection,
        runtimePolicy,
        memoryContext: snapshot,
        refreshMemoryContext: () =>
          Effect.sync(() => {
            refreshes++;
            return memory;
          }),
        runId: RunId.make("cursor-error-run"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("cursor-error-attempt"),
        rootNodeId: NodeId.make("cursor-error-root"),
        appThread,
        message: {
          messageId: MessageId.make("cursor-error-message"),
          createdBy: "user",
          creationSource: "web",
          text: "continue",
          attachments: [],
        },
      };
      yield* runtime.startTurn(ordinaryInput);
      const first = yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
      assert.isTrue(Option.isSome(first));
      if (Option.isSome(first)) {
        assert.equal(first.value.status, "failed");
        assert.equal(first.value.failure?.class, "transport_error");
      }

      assert.include(sentMessages[0]!, memoryContextText(snapshot));
      assert.equal(refreshes, 1);
      assert.include(sentMessages[0]!, "read=true, write=true, source=true");
      assert.isDefined(runtime.compactThread);
      yield* runtime.compactThread!({
        threadId,
        providerThread,
        modelSelection,
        runtimePolicy,
        refreshMemoryContext: ordinaryInput.refreshMemoryContext!,
        runId: RunId.make("cursor-compact-run"),
        runOrdinal: 2,
        providerTurnOrdinal: 2,
        attemptId: RunAttemptId.make("cursor-compact-attempt"),
        rootNodeId: NodeId.make("cursor-compact-root"),
        appThread,
        message: {
          messageId: MessageId.make("cursor-compact-message"),
          createdBy: "user",
          creationSource: "web",
          text: "ignored by compactThread",
          attachments: [],
        },
      });
      yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
      assert.equal(sentMessages[1], "/compress");
      assert.equal(refreshes, 1);
      memory = undefined;
      yield* sessions.set(config([]));
      yield* runtime.startTurn({
        ...ordinaryInput,
        runOrdinal: 3,
        providerTurnOrdinal: 3,
        message: {
          ...ordinaryInput.message,
          attachments: [
            {
              type: "image",
              id: "memory.png",
              name: "memory.png",
              mimeType: "image/png",
              sizeBytes: 13,
            },
          ],
        },
      });
      yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
      assert.notInclude(sentMessages[2]!, "external_goat_memory");
      assert.equal(refreshes, 2);
      assert.deepEqual(imageCounts, [0, 0, 1]);
      assert.include(sentMessages[2]!, "read=false, write=false, source=false");
      yield* runtime.startTurn({ ...ordinaryInput, runOrdinal: 4, providerTurnOrdinal: 4 });
      yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
      assert.notInclude(sentMessages[3]!, "GOAT memory tools:");
      memory = snapshot;
      const grants: ReadonlyArray<ReadonlyArray<AuthEnvironmentScope>> = [
        ["memory:read"],
        ["memory:read", "memory:write", "orchestration:read"],
      ];
      for (const [index, grant] of grants.entries()) {
        yield* sessions.set(config(grant));
        yield* runtime.startTurn({
          ...ordinaryInput,
          runOrdinal: index + 5,
          providerTurnOrdinal: index + 5,
        });
        yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
        );
        assert.include(sentMessages[index + 4]!, memoryContextText(snapshot));
        assert.include(
          sentMessages[index + 4]!,
          `read=true, write=${index === 1}, source=${index === 1}`,
        );
      }
      // Grants alone reuse the installed transport; attachment changes reopen the same agent.
      assert.equal(opens.length, 1);
      assert.equal(closes, 0);
      const baseConfig = config(["memory:read", "memory:write", "orchestration:read"]);
      const endpointConfig = { ...baseConfig, endpoint: "http://rotated.fixture.invalid/mcp" };
      const authorizationConfig = {
        ...endpointConfig,
        authorizationHeader: "Bearer rotated-fixture",
      };
      const attachments = [
        undefined,
        baseConfig,
        endpointConfig,
        authorizationConfig,
        authorizationConfig,
      ];
      for (const [index, attachment] of attachments.entries()) {
        if (attachment === undefined) yield* sessions.clear(threadId);
        else yield* sessions.set(attachment);
        yield* runtime.startTurn({
          ...ordinaryInput,
          runOrdinal: index + 7,
          providerTurnOrdinal: index + 7,
        });
        yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
        );
        const expectedChanges = Math.min(index + 1, 4);
        assert.equal(opens.length, expectedChanges + 1);
        assert.equal(closes, expectedChanges);
        const opened = opens[opens.length - 1]!;
        assert.equal(opened.operation, "resume");
        assert.equal(opened.agentId, "native-cursor-error");
        assert.deepEqual(opened.options.mcpServers, cursorMcpServers(attachment));
        assert.include(sentMessages[index + 6]!, memoryContextText(snapshot));
        assert.include(
          sentMessages[index + 6]!,
          attachment === undefined
            ? "read=false, write=false, source=false"
            : "read=true, write=true, source=true",
        );
      }
      assert.equal(refreshes, 10);
      assert.deepEqual(connections, [
        "open",
        "close",
        "open",
        "close",
        "open",
        "close",
        "open",
        "close",
        "open",
      ]);
      const movedPolicy = { ...runtimePolicy, cwd: `${workspace}/moved` };
      yield* runtime.startTurn({
        ...ordinaryInput,
        runtimePolicy: movedPolicy,
        runOrdinal: 12,
        providerTurnOrdinal: 12,
      });
      yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
      assert.equal(opens.length, 6);
      assert.equal(closes, 5);
      assert.equal(opens[5]!.agentId, "native-cursor-error");
      assert.equal(opens[5]!.options.local?.cwd, movedPolicy.cwd);
      assert.include(sentMessages[11]!, "read=true, write=true, source=true");
      // Servers are fixed when the agent opens: enabling computer use reopens the
      // same agent with the driver, and only then does the prompt describe it.
      const cuaDriver = {
        command: "/resources/cua-driver",
        args: ["mcp"],
        environment: [{ name: "CUA_DRIVER_RS_TELEMETRY_ENABLED", value: "false" }],
      };
      for (const [offset, attachment] of [
        { ...authorizationConfig, cuaDriver },
        authorizationConfig,
      ].entries()) {
        yield* sessions.set(attachment);
        yield* runtime.startTurn({
          ...ordinaryInput,
          runtimePolicy: movedPolicy,
          runOrdinal: 13 + offset,
          providerTurnOrdinal: 13 + offset,
        });
        yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
        );
        assert.equal(opens.length, 7 + offset);
        assert.equal(opens[6 + offset]!.operation, "resume");
        assert.deepEqual(
          opens[6 + offset]!.options.mcpServers?.["cua-driver"],
          offset === 0
            ? {
                type: "stdio",
                command: "/resources/cua-driver",
                args: ["mcp"],
                env: { CUA_DRIVER_RS_TELEMETRY_ENABLED: "false" },
              }
            : undefined,
        );
        assert.equal(sentMessages[12 + offset]!.includes("<computer_use>"), offset === 0);
      }
      memory = { ...snapshot, renderedText: snapshot.renderedText.replace("data", "tampered") };
      const failed = yield* runtime
        .startTurn({ ...ordinaryInput, runOrdinal: 4, providerTurnOrdinal: 4 })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(failed));
      assert.equal(sentMessages.length, 14);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
      ),
    ),
  );

  it.effect("projects Cursor directory trees and lint diagnostics as file search results", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-v2-search-" });
      const instanceId = ProviderInstanceId.make("cursor");
      const threadId = ThreadId.make("cursor-search-thread");
      const modelSelection = { instanceId, model: "composer-2.5" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const emptyLsNode = {
        childrenDirs: [],
        childrenFiles: [],
        childrenWereProcessed: true,
        fullSubtreeExtensionCounts: {},
        numFiles: 0,
      };
      const updates: ReadonlyArray<InteractionUpdate> = [
        ...(["tool-call-started", "tool-call-completed"] as const).map((type) => ({
          type,
          modelCallId: "native-model-call",
          callId: "mcp-weather",
          toolCall: {
            type: "mcp" as const,
            args: {
              providerIdentifier: "weather",
              toolName: "get_weather",
              args: { city: "Berlin" },
            },
            ...(type === "tool-call-completed"
              ? { result: { status: "success" as const, value: { content: [], isError: false } } }
              : {}),
          },
        })),
        {
          type: "tool-call-completed",
          modelCallId: "native-model-call",
          callId: "read-file",
          toolCall: {
            type: "read",
            args: { path: "src/env.ts" },
            result: {
              status: "success",
              value: { fileSize: 12, content: "---\nfile body", totalLines: 2 },
            },
          },
        },
        {
          type: "tool-call-completed",
          modelCallId: "native-model-call",
          callId: "ls-nested",
          toolCall: {
            type: "ls",
            args: { path: workspace },
            result: {
              status: "success",
              value: {
                directoryTreeRoot: {
                  ...emptyLsNode,
                  absPath: workspace,
                  childrenFiles: [{ name: "README.md" }],
                  childrenDirs: [
                    {
                      ...emptyLsNode,
                      absPath: path.join(workspace, "src"),
                      childrenFiles: [{ name: "index.ts" }],
                      childrenDirs: [
                        {
                          ...emptyLsNode,
                          absPath: path.join(workspace, "src", "nested"),
                          childrenFiles: [{ name: "util.ts" }],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
        {
          type: "tool-call-completed",
          modelCallId: "native-model-call",
          callId: "ls-empty",
          toolCall: {
            type: "ls",
            args: { path: path.join(workspace, "empty") },
            result: {
              status: "success",
              value: {
                directoryTreeRoot: { ...emptyLsNode, absPath: path.join(workspace, "empty") },
              },
            },
          },
        },
        {
          type: "tool-call-completed",
          modelCallId: "native-model-call",
          callId: "ls-failed",
          toolCall: {
            type: "ls",
            args: { path: path.join(workspace, "missing") },
            result: { status: "error", error: "ENOENT" },
          },
        },
        {
          type: "tool-call-completed",
          modelCallId: "native-model-call",
          callId: "grep-failed",
          toolCall: {
            type: "grep",
            args: { pattern: "TODO", path: "src" },
            result: { status: "error", error: "search failed" },
          },
        },
        {
          type: "tool-call-completed",
          modelCallId: "native-model-call",
          callId: "glob-failed",
          toolCall: {
            type: "glob",
            args: { globPattern: "*.ts" },
            result: { status: "error", error: "search failed" },
          },
        },
        {
          type: "tool-call-completed",
          modelCallId: "native-model-call",
          callId: "lints",
          toolCall: {
            type: "readLints",
            args: { paths: ["src/a.ts", "src/b.ts"] },
            result: {
              status: "success",
              value: {
                totalFiles: 2,
                totalDiagnostics: 3,
                fileDiagnostics: [
                  {
                    path: "src/a.ts",
                    diagnosticsCount: 2,
                    diagnostics: [
                      {
                        message: "Unused variable",
                        code: "TS6133",
                        source: "ts",
                        severity: "warning",
                        range: { start: { line: 0, character: 4 } },
                      },
                      {
                        message: "Cannot find name",
                        code: "TS2304",
                        source: "ts",
                        severity: "error",
                        range: { start: { line: 11 } },
                      },
                    ],
                  },
                  {
                    path: "src/b.ts",
                    diagnosticsCount: 1,
                    diagnostics: [
                      {
                        message: "File-level diagnostic",
                        code: "TS0",
                        source: "ts",
                        severity: "information",
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
        {
          type: "tool-call-completed",
          modelCallId: "native-model-call",
          callId: "lints-empty",
          toolCall: {
            type: "readLints",
            args: { paths: ["src/clean.ts"] },
            result: {
              status: "success",
              value: {
                totalFiles: 1,
                totalDiagnostics: 0,
                fileDiagnostics: [{ path: "src/clean.ts", diagnosticsCount: 0, diagnostics: [] }],
              },
            },
          },
        },
        {
          type: "tool-call-completed",
          modelCallId: "native-model-call",
          callId: "lints-failed",
          toolCall: {
            type: "readLints",
            args: { paths: ["src/a.ts"] },
            result: { status: "error", error: "lint failed" },
          },
        },
      ];
      const adapter = yield* makeCursorAdapterV2({
        instanceId,
        settings: yield* decodeCursorSettings({}),
        environment: { HOME: workspace },
      }).pipe(
        Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
          assertComplete: Effect.void,
          open: () =>
            Effect.succeed({
              agentId: "native-cursor-search",
              listMessages: Effect.succeed([]),
              close: Effect.void,
              send: (input) =>
                Effect.gen(function* () {
                  for (const update of updates) {
                    if (input.onDelta !== undefined) {
                      yield* input.onDelta(update).pipe(Effect.orDie);
                    }
                  }
                  return {
                    agentId: "native-cursor-search",
                    runId: "native-cursor-run",
                    wait: Effect.succeed({
                      id: "native-cursor-run",
                      requestId: "native-request",
                      status: "finished" as const,
                      model: { id: "composer-2.5" },
                      durationMs: 1,
                    }),
                    cancel: Effect.void,
                  };
                }),
            }),
        }),
        Effect.provide(TestProviderHost.layer({ cwd: workspace })),
      );
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-search-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime.startTurn({
        threadId,
        providerThread,
        modelSelection,
        runtimePolicy,
        runId: RunId.make("cursor-search-run"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("cursor-search-attempt"),
        rootNodeId: NodeId.make("cursor-search-root"),
        appThread: {
          id: threadId,
          projectId: ProjectId.make("cursor-search-project"),
          createdBy: "user",
          creationSource: "web",
          title: "Cursor search results",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
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
        message: {
          messageId: MessageId.make("cursor-search-message"),
          createdBy: "user",
          creationSource: "web",
          text: "inspect the workspace",
          attachments: [],
        },
      });
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      );
      const mcpItems = events.flatMap((event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "dynamic_tool" &&
        event.turnItem.toolName === "mcp__weather__get_weather"
          ? [event.turnItem]
          : [],
      );
      assert.deepEqual(
        mcpItems.map((item) => item.status),
        ["running", "completed"],
      );
      for (const item of mcpItems) {
        assert.equal(item.title, "get weather");
        assert.deepEqual(item.toolSource, {
          key: "mcp:weather",
          name: "weather",
          kind: "integration",
        });
        assert.deepEqual(item.input, { city: "Berlin" });
      }
      const fileSearchItems = events.flatMap((event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "file_search" &&
        event.turnItem.status !== "running"
          ? [event.turnItem]
          : [],
      );
      const readItems = events.flatMap((event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "dynamic_tool" &&
        event.turnItem.toolName === "Read" &&
        event.turnItem.status === "completed"
          ? [event.turnItem]
          : [],
      );
      assert.deepEqual(
        readItems.map((item) => ({ title: item.title, input: item.input })),
        [{ title: "Read src/env.ts", input: { path: "src/env.ts" } }],
      );
      assert.deepEqual(
        fileSearchItems.map((item) => ({
          pattern: item.pattern,
          status: item.status,
          results: item.results,
        })),
        [
          {
            pattern: workspace,
            status: "completed",
            results: [
              { fileName: path.join(workspace, "README.md") },
              { fileName: path.join(workspace, "src", "index.ts") },
              { fileName: path.join(workspace, "src", "nested", "util.ts") },
            ],
          },
          {
            pattern: path.join(workspace, "empty"),
            status: "completed",
            results: undefined,
          },
          {
            pattern: path.join(workspace, "missing"),
            status: "failed",
            results: [{ fileName: path.join(workspace, "missing"), preview: "ENOENT" }],
          },
          {
            pattern: "TODO",
            status: "failed",
            results: [{ fileName: "src", preview: "search failed" }],
          },
          {
            pattern: "*.ts",
            status: "failed",
            results: [{ fileName: ".", preview: "search failed" }],
          },
          {
            pattern: "src/a.ts, src/b.ts",
            status: "completed",
            results: [
              { fileName: "src/a.ts", line: 1, column: 5, preview: "Unused variable" },
              { fileName: "src/a.ts", line: 12, preview: "Cannot find name" },
              { fileName: "src/b.ts", preview: "File-level diagnostic" },
            ],
          },
          {
            pattern: "src/clean.ts",
            status: "completed",
            results: undefined,
          },
          {
            pattern: "src/a.ts",
            status: "failed",
            results: [{ fileName: "src/a.ts", preview: "lint failed" }],
          },
        ],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
      ),
    ),
  );

  it.effect("names a custom model Cursor's account catalog rejects", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-v2-model-" });
      const instanceId = ProviderInstanceId.make("cursor");
      const threadId = ThreadId.make("cursor-custom-model-thread");
      const catalogModel = { instanceId, model: "composer-2.5" };
      const customModel = { instanceId, model: "deepseek/deepseek-v4.1-flash" };
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      // The SDK checks every create, resume, and send model against the account catalog.
      const checkModel = (method: string, model: { readonly id: string } | undefined) =>
        model === undefined || model.id === "composer-2.5"
          ? Effect.void
          : Effect.fail(
              new CursorAgentSdk.CursorAgentSdkRunnerError({
                method,
                cause: new ConfigurationError(
                  `Cannot use this model: ${model.id}. Available models: default, composer-2.5. Use Cursor.models.list() to discover valid selections.`,
                  { isRetryable: false },
                ),
              }),
            );
      const adapter = yield* makeCursorAdapterV2({
        instanceId,
        settings: yield* decodeCursorSettings({}),
        environment: { HOME: workspace },
      }).pipe(
        Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
          assertComplete: Effect.void,
          open: (input) =>
            checkModel(`agent.${input.operation}`, input.options.model).pipe(
              Effect.as({
                agentId: "native-cursor-custom-model",
                listMessages: Effect.succeed([]),
                close: Effect.void,
                send: (sendInput) =>
                  checkModel("run.start", sendInput.options?.model).pipe(
                    Effect.andThen(Effect.die("unexpected Cursor run")),
                  ),
              }),
            ),
        }),
        Effect.provide(TestProviderHost.layer({ cwd: workspace })),
      );
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-custom-model-session"),
        modelSelection: catalogModel,
        runtimePolicy,
      });
      const expected =
        'Cursor cannot run the model "deepseek/deepseek-v4.1-flash". Cursor only runs models from your Cursor account. Choose one of those, or use OpenCode for OpenRouter and other API-key models.';

      // A new thread created with the custom model.
      const createFailure = yield* runtime
        .ensureThread({ threadId, modelSelection: customModel, runtimePolicy })
        .pipe(Effect.flip);
      assert.equal(makeProviderFailure({ cause: createFailure }).message, expected);

      // An existing thread switched to the custom model.
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: catalogModel,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      const sendFailure = yield* runtime
        .startTurn({
          threadId,
          providerThread,
          modelSelection: customModel,
          runtimePolicy,
          runId: RunId.make("cursor-custom-model-run"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("cursor-custom-model-attempt"),
          rootNodeId: NodeId.make("cursor-custom-model-root"),
          appThread: {
            id: threadId,
            projectId: ProjectId.make("cursor-custom-model-project"),
            createdBy: "user",
            creationSource: "web",
            title: "Cursor custom model",
            providerInstanceId: instanceId,
            modelSelection: customModel,
            runtimeMode: "full-access",
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
          message: {
            messageId: MessageId.make("cursor-custom-model-message"),
            createdBy: "user",
            creationSource: "web",
            text: "Hello.",
            attachments: [],
          },
        })
        .pipe(Effect.flip);
      assert.equal(makeProviderFailure({ cause: sendFailure }).message, expected);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
      ),
    ),
  );

  it("maps runtime modes to the SDK sandbox and auto-review controls", () => {
    const base = {
      interactionMode: "default" as const,
      cwd: "/tmp/cursor-adapter",
    };
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "full-access",
        },
        "linux",
      ),
      {
        autoReview: false,
        sandboxEnabled: false,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "auto-accept-edits",
        },
        "linux",
      ),
      {
        autoReview: false,
        sandboxEnabled: true,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "auto",
        },
        "linux",
      ),
      {
        autoReview: true,
        sandboxEnabled: true,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "approval-required",
        },
        "linux",
      ),
      {
        autoReview: true,
        sandboxEnabled: true,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "full-access",
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly" },
        },
        "linux",
      ),
      {
        autoReview: false,
        sandboxEnabled: true,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "approval-required",
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
        },
        "linux",
      ),
      {
        autoReview: false,
        sandboxEnabled: false,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "auto-accept-edits",
        },
        "win32",
      ),
      {
        autoReview: false,
        sandboxEnabled: true,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "auto",
          approvalPolicy: "never",
        },
        "win32",
      ),
      {
        autoReview: false,
        sandboxEnabled: true,
      },
    );
    // Auto-review can gate Windows execution without the unsupported SDK sandbox.
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "auto",
        },
        "win32",
      ),
      {
        autoReview: true,
        sandboxEnabled: false,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy(
        {
          ...base,
          runtimeMode: "auto",
          sandboxPolicy: { type: "workspaceWrite" },
        },
        "win32",
      ),
      {
        autoReview: true,
        sandboxEnabled: true,
      },
    );
  });

  it("injects thread-scoped MCP credentials without logging them", () => {
    const threadId = ThreadId.make("thread-cursor-mcp");
    const mcpSession = {
      environmentId: EnvironmentId.make("environment-cursor-mcp"),
      threadId,
      providerSessionId: "mcp-session-cursor",
      providerInstanceId: ProviderInstanceId.make("cursor"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer secret-cursor-mcp-token",
      browserToolsAvailable: true,
    };

    assert.deepEqual(cursorMcpServers(mcpSession), {
      goat: {
        type: "http",
        url: "http://127.0.0.1:43123/mcp",
        headers: {
          Authorization: "Bearer secret-cursor-mcp-token",
        },
      },
    });

    const options = makeCursorAgentOptions({
      apiKey: "secret-cursor-api-key",
      modelSelection: {
        instanceId: ProviderInstanceId.make("cursor"),
        model: "composer-2.5",
      },
      runtimePolicy: {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
      },
      threadId,
      mcpSession,
      platform: "linux",
    });
    assert.deepEqual(options.mcpServers, cursorMcpServers(mcpSession));

    const logged = JSON.stringify(CursorAgentSdk.loggedCursorAgentOptions(options));
    assert.notInclude(logged, "secret-cursor-api-key");
    assert.notInclude(logged, "secret-cursor-mcp-token");
  });

  it("recognizes direct and SDK-wrapped abort failures as cancellation", () => {
    assert.isTrue(CursorAgentSdk.isCursorCancellationError({ name: "AbortError" }));
    assert.isTrue(
      CursorAgentSdk.isCursorCancellationError({
        name: "ConnectError",
        cause: {
          name: "ConnectError",
          cause: { name: "AbortError" },
        },
      }),
    );
    assert.isFalse(CursorAgentSdk.isCursorCancellationError(new Error("request failed")));
    assert.isFalse(CursorAgentSdk.isCursorCancellationError(null));
  });

  it("preserves failed nested read calls when Cursor omits their path", () => {
    assert.deepEqual(
      nestedToolCallFromEnvelope({
        toolCallId: "tool:failed-read",
        readToolCall: {
          args: {},
          result: { error: "File path was not provided." },
        },
      }),
      {
        callId: "tool:failed-read",
        toolCall: {
          type: "read",
          args: { path: "<unknown path>" },
          result: {
            status: "error",
            error: "File path was not provided.",
          },
        },
      },
    );
  });
});

const wp4Snapshot = () =>
  packMemoryContext({
    memorySpaceId: MemorySpaceId.make("00000000-0000-4000-8000-000000000099"),
    projectionWatermark: 1,
    items: [
      {
        memoryId: MemoryId.make("00000000-0000-4000-8000-000000000001"),
        revisionId: MemoryRevisionId.make("00000000-0000-4000-8000-000000000002"),
        scope: { kind: "user" },
        provenance: { environmentId: EnvironmentId.make("fixture") },
        assertionKind: "fact",
        text: "& <instruction> 'data'",
      },
    ],
  })!;
