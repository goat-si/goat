import * as NodeServices from "@effect/platform-node/NodeServices";
import type { InteractionUpdate } from "@cursor/sdk";
import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { CursorSettings } from "../settings.ts";
import { makeCursorAdapterV2 } from "./adapter.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";

const decodeCursorSettings = Schema.decodeEffect(CursorSettings);

const shellOutputByCommand = (updates: ReadonlyArray<InteractionUpdate>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-shell-output-" });
    const hostContext = yield* Layer.build(TestProviderHost.layer({ cwd: workspace }));
    const instanceId = ProviderInstanceId.make("cursor");
    const threadId = ThreadId.make("cursor-shell-output-thread");
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
            agentId: "native-cursor-shell",
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
                  agentId: "native-cursor-shell",
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
      Effect.provide(hostContext),
    );
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("cursor-shell-output-session"),
      modelSelection,
      runtimePolicy,
    });
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    const now = yield* DateTime.now;
    yield* runtime.startTurn({
      threadId,
      providerThread,
      modelSelection,
      runtimePolicy,
      runId: RunId.make("cursor-shell-output-run"),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make("cursor-shell-output-attempt"),
      rootNodeId: NodeId.make("cursor-shell-output-root"),
      appThread: {
        id: threadId,
        projectId: ProjectId.make("cursor-shell-output-project"),
        createdBy: "user",
        creationSource: "web",
        title: "Cursor shell output",
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
        messageId: MessageId.make("cursor-shell-output-message"),
        createdBy: "user",
        creationSource: "web",
        text: "run both",
        attachments: [],
      },
    });
    const events = Array.from(
      yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      ),
    );

    const shellItemIds = new Map(
      events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "command_execution"
          ? [[event.turnItem.id, event.turnItem.input] as const]
          : [],
      ),
    );
    return events.flatMap((event) =>
      event.type === "command_output.delta"
        ? [{ command: shellItemIds.get(event.itemId), chunk: event.chunk }]
        : [],
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
    ),
  );

const startedShells: ReadonlyArray<InteractionUpdate> = ["slow-shell", "fast-shell"].map(
  (callId) => ({
    type: "tool-call-started" as const,
    modelCallId: "native-model-call",
    callId,
    toolCall: { type: "shell" as const, args: { command: callId } },
  }),
);

it.effect("streams shell output into the command its toolCallId names, not the latest shell", () =>
  Effect.gen(function* () {
    const deltas = yield* shellOutputByCommand([
      ...startedShells,
      {
        type: "shell-output-delta",
        event: { case: "stdout", value: { data: "tick 1\n" }, toolCallId: "slow-shell" },
      },
      {
        type: "shell-output-delta",
        event: { case: "exit", value: { code: 0 }, toolCallId: "slow-shell" },
      },
    ]);
    assert.deepEqual(deltas, [{ command: "slow-shell", chunk: "tick 1\n" }]);
  }),
);

it.effect("older SDK output without a toolCallId still reaches the latest shell", () =>
  Effect.gen(function* () {
    const deltas = yield* shellOutputByCommand([
      ...startedShells,
      { type: "shell-output-delta", event: { case: "stderr", value: { data: "warn\n" } } },
      { type: "shell-output-delta", event: { case: "stdout", value: { data: 42 } } },
    ]);
    assert.deepEqual(deltas, [{ command: "fast-shell", chunk: "warn\n" }]);
  }),
);
