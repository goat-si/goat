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
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { CursorSettings } from "../settings.ts";
import { makeCursorAdapterV2 } from "./adapter.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";

const decodeCursorSettings = Schema.decodeEffect(CursorSettings);
const shell = { type: "shell" as const, args: { command: "yes" } };
const started: InteractionUpdate = {
  type: "tool-call-started",
  modelCallId: "model-call",
  callId: "shell-call",
  toolCall: shell,
};
const stdout = (data: string): InteractionUpdate => ({
  type: "shell-output-delta",
  event: { case: "stdout", value: { data }, toolCallId: "shell-call" },
});

/** Opens a Cursor session whose run emits the updates on its own fiber, as the SDK does. */
const startShellTurn = (updates: ReadonlyArray<InteractionUpdate>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-output-gate-" });
    const hostContext = yield* Layer.build(TestProviderHost.layer({ cwd: workspace }));
    const instanceId = ProviderInstanceId.make("cursor");
    const threadId = ThreadId.make("cursor-output-gate-thread");
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
            agentId: "native-cursor-output-gate",
            listMessages: Effect.succeed([]),
            close: Effect.void,
            send: (input) =>
              Effect.gen(function* () {
                const emitting = yield* Effect.forEach(
                  updates,
                  (update) => input.onDelta?.(update).pipe(Effect.orDie) ?? Effect.void,
                  { discard: true },
                ).pipe(Effect.forkDetach);
                return {
                  agentId: "native-cursor-output-gate",
                  runId: "native-cursor-run",
                  wait: Fiber.join(emitting).pipe(
                    Effect.as({
                      id: "native-cursor-run",
                      requestId: "native-request",
                      status: "finished" as const,
                      model: { id: "composer-2.5" },
                      durationMs: 1,
                    }),
                  ),
                  cancel: Effect.void,
                };
              }),
          }),
      }),
      Effect.provide(hostContext),
    );
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("cursor-output-gate-session"),
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
      runId: RunId.make("cursor-output-gate-run"),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make("cursor-output-gate-attempt"),
      rootNodeId: NodeId.make("cursor-output-gate-root"),
      appThread: {
        id: threadId,
        projectId: ProjectId.make("cursor-output-gate-project"),
        createdBy: "user",
        creationSource: "web",
        title: "Cursor output gate",
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
        messageId: MessageId.make("cursor-output-gate-message"),
        createdBy: "user",
        creationSource: "web",
        text: "run it",
        attachments: [],
      },
    });
    return { runtime, providerThread };
  });

const layer = Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer);

// Upstream 6be1bd6472's case, here because adapter.test.ts is at its budget.
it.effect("keeps the last 256 KiB of streamed shell output when the result carries none", () =>
  Effect.gen(function* () {
    const chunks = Array.from({ length: 3000 }, (_, index) => `${index}`.padEnd(255, ".") + "\n");
    const { runtime } = yield* startShellTurn([
      started,
      ...chunks.map(stdout),
      {
        type: "tool-call-completed",
        modelCallId: "model-call",
        callId: "shell-call",
        toolCall: {
          ...shell,
          result: {
            status: "success",
            value: { exitCode: 0, signal: "", stdout: "", stderr: "", executionTime: 0 },
          },
        },
      } as InteractionUpdate,
    ]);
    const events = yield* runtime.events.pipe(
      Stream.takeUntil((event) => event.type === "turn.terminal"),
      Stream.runCollect,
    );
    const output = Array.from(events)
      .flatMap((event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "command_execution" &&
        event.turnItem.status === "completed"
          ? [event.turnItem.output]
          : [],
      )
      .at(-1);
    assert.equal(output, chunks.join("").slice(-256 * 1024));
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("Stop ends the turn while live output fills the gate and nothing reads the events", () =>
  Effect.gen(function* () {
    const chunk = "x".repeat(256 * 1024);
    const { runtime, providerThread } = yield* startShellTurn([
      started,
      ...Array.from({ length: 20 }, () => stdout(chunk)),
    ]);
    const before = yield* runtime.events.pipe(
      Stream.takeUntil((event) => event.type === "provider_turn.updated"),
      Stream.runCollect,
    );
    const running = Array.from(before).at(-1);
    if (running?.type !== "provider_turn.updated") return assert.fail("no running turn");
    yield* runtime.interruptTurn({ providerThread, providerTurnId: running.providerTurn.id });
    const after = Array.from(
      yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      ),
    );
    const deltas = after.filter((event) => event.type === "command_output.delta");
    assert.isBelow(deltas.length, 20);
    assert.equal(after.at(-1)?.type, "turn.terminal");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
