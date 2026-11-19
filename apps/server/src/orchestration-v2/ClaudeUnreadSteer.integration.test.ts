import * as DateTime from "effect/DateTime";
import * as EventSink from "./EventSink.ts";
import * as MemoryDerivedCache from "../memory/MemoryDerivedCache.ts";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type RunId,
  type OrchestrationV2DomainEvent,
} from "@goat/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ClaudeAdapterV2 from "./Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@goat/provider-testing/replayWorkspace";
const sessionId = "automatic-delivery-session";
const settings = Schema.decodeSync(ClaudeSettings)({});
const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
};
function frame(value: unknown): SDKMessage {
  return value as SDKMessage;
}
const result = (uuid: string, aborted: boolean) =>
  frame({
    type: "result",
    subtype: "success",
    uuid,
    session_id: sessionId,
    is_error: false,
    num_turns: 1,
    result: "",
    stop_reason: "end_turn",
    terminal_reason: aborted ? "aborted_tools" : "completed",
    permission_denials: [],
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
  });
// A steer Claude never read runs as the next turn, between the messages sent before and after
// it, even when they share a millisecond and the later one picks another model.
it.effect.each([
  "Claude cancels it twice",
  "the Claude process exits",
  "the server restarts",
  "Claude cancels it and the user stops",
] as const)("handles an unread steer when %s", (outcome) =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace("claude-unread-steer");
    const sdkMessages = yield* Queue.unbounded<SDKMessage>();
    const offers: SDKUserMessage[] = [];
    const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: modelSelection.instanceId,
      settings,
      environment: {},
      attachmentsDir: cwd,
      fileSystem: yield* FileSystem.FileSystem,
      path: yield* Path.Path,
      random: yield* SecureRandom.SecureRandom,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      queryRunner: {
        allocateSessionId: Effect.succeed(sessionId),
        open: () =>
          Effect.succeed({
            messages: Stream.fromQueue(sdkMessages),
            offer: (message) => Effect.sync(() => void offers.push(message)),
            setModel: () => Effect.void,
            applyFlagSettings: () => Effect.void,
            setPermissionMode: () => Effect.void,
            renameSession: () => Effect.void,
            backgroundTasks: () => Effect.succeed(false),
            mcpServerStatus: Effect.succeed([]),
            readMcpResource: () => Effect.die("unexpected MCP resource read"),
            callMcpTool: () => Effect.die("unexpected MCP tool call"),
            listPermissionRules: Effect.die("unexpected permission rules read"),
            stopTask: () => Effect.void,
            interrupt: Queue.shutdown(sdkMessages),
            close: Effect.void,
          }),
        forkSession: () => Effect.die("unused"),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        subagentModel: () => Effect.succeed(null),
        assertComplete: Effect.void,
      },
    });
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make("thread:unread-steer");
      const steerId = MessageId.make("steer");
      const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
        orchestrator.streamDomainEvents.pipe(
          Stream.filter(predicate),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
      const settled = (runId: RunId, status: "waiting") =>
        watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === runId &&
            event.payload.status === status,
        );
      const pending = () =>
        watch(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "user_message" &&
            event.payload.messageId === steerId &&
            event.payload.status === "pending",
        );
      const answer = (offer: SDKUserMessage) =>
        Queue.offer(
          sdkMessages,
          frame({
            ...(result(`result-${offer.uuid}`, false) as object),
            user_message_uuid: offer.uuid,
          }),
        );
      const cancel = (offer: SDKUserMessage) =>
        Queue.offer(
          sdkMessages,
          frame({
            type: "command_lifecycle",
            command_uuid: offer.uuid,
            state: "cancelled",
            uuid: `cancelled-${offer.uuid}`,
            session_id: sessionId,
          }),
        );
      const offeredText = (offer: SDKUserMessage | undefined) =>
        JSON.stringify(offer?.message.content ?? null);
      const queued = Effect.map(orchestrator.getThreadProjection(threadId), (projection) =>
        projection.runs
          .filter((run) => run.status === "queued")
          .toSorted(
            (left, right) =>
              (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal),
          ),
      );
      const queuedOrder = Effect.map(queued, (runs) =>
        runs.map((run) => [run.userMessageId, run.queueHeld === true]),
      );
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make("project:unread-steer"),
        title: "Unread steer",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
        createdBy: "user",
        creationSource: "web",
      });
      const running = yield* watch(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      );
      const send = (
        id: string,
        dispatchMode:
          | { readonly type: "start_immediately" | "queue_after_active" }
          | { readonly type: "steer_active"; readonly targetRunId: RunId },
        model?: string,
      ) =>
        orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(id),
          threadId,
          messageId: MessageId.make(id),
          text: `Message ${id}`,
          attachments: [],
          ...(model === undefined ? {} : { modelSelection: { ...modelSelection, model } }),
          dispatchMode,
          createdBy: "user",
          creationSource: "web",
        });
      yield* send("first", { type: "start_immediately" });
      yield* worker.drain();
      yield* Fiber.join(running);
      const parent = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      yield* send("before", { type: "queue_after_active" });
      const unread = yield* pending();
      yield* send("steer", { type: "steer_active", targetRunId: parent.id });
      yield* worker.drain();
      yield* Fiber.join(unread);
      yield* send("after", { type: "queue_after_active" }, "claude-opus-4-1");
      assert.deepEqual(
        offers.map((offer) => offer.priority),
        [undefined, "next"],
      );

      if (outcome === "Claude cancels it twice") {
        const ended = yield* settled(parent.id, "waiting");
        const nextRunning = yield* watch(
          (event) =>
            event.type === "provider-turn.updated" &&
            event.payload.status === "running" &&
            event.payload.runAttemptId !== parent.activeAttemptId,
        );
        const nextStarting = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id !== parent.id &&
            event.payload.status === "starting",
        );
        yield* answer(offers[0]!);
        yield* cancel(offers[1]!);
        yield* Fiber.join(ended);
        yield* worker.drain();
        yield* Fiber.join(nextStarting);
        yield* worker.drain();
        yield* Fiber.join(nextRunning);
        // The older message runs first; the steer waits right behind it on its own model.
        const behind = yield* queued;
        assert.deepEqual(
          behind.map((run) => run.userMessageId),
          [steerId, MessageId.make("after")],
        );
        assert.deepEqual(behind[0]?.modelSelection, modelSelection);
        assert.include(offeredText(offers[2]), "Message before");
        // Promoted into that run, Claude drops it again; it is queued again, then reaches Claude.
        const before = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === MessageId.make("before"),
        )!;
        yield* orchestrator.dispatch({
          type: "queued-message.promote-to-steer",
          commandId: CommandId.make("promote"),
          threadId,
          queuedRunId: behind[0]!.id,
          targetRunId: before.id,
        });
        yield* worker.drain();
        assert.equal(offers[3]?.priority, "next");
        const beforeEnded = yield* settled(before.id, "waiting");
        const steerStarting = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.userMessageId === steerId &&
            event.payload.status === "starting",
        );
        yield* answer(offers[2]!);
        yield* cancel(offers[3]!);
        yield* Fiber.join(beforeEnded);
        yield* worker.drain();
        yield* Fiber.join(steerStarting);
        yield* worker.drain();
        assert.deepEqual(yield* queuedOrder, [[MessageId.make("after"), false]]);
        assert.equal(offers.length, 5);
        assert.equal(offers[4]?.priority, undefined);
        assert.include(offeredText(offers[4]), "Message steer");
        return;
      }

      if (outcome === "the Claude process exits") {
        const requeued = yield* watch(
          (event) =>
            (event.type === "run.updated" || event.type === "run.created") &&
            event.payload.userMessageId === steerId &&
            event.payload.status === "queued",
        );
        const held = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.userMessageId === steerId &&
            event.payload.queueHeld === true,
        );
        yield* Queue.shutdown(sdkMessages);
        yield* Fiber.join(requeued);
        yield* Fiber.join(held);
        yield* worker.drain();
        // The provider failure holds the queue, the follow-up included, until someone resumes it.
        assert.deepEqual(yield* queuedOrder, [
          [MessageId.make("before"), true],
          [steerId, true],
          [MessageId.make("after"), true],
        ]);
        assert.equal(offers.length, 2);
        return;
      }

      if (outcome === "Claude cancels it and the user stops") {
        yield* cancel(offers[1]!);
        const dropped = yield* watch(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "user_message" &&
            event.payload.messageId === steerId &&
            event.payload.status === "cancelled",
        );
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop"),
          threadId,
          runId: parent.id,
          holdQueue: true,
        });
        yield* worker.drain();
        yield* Fiber.join(dropped);
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          after.turnItems.find((item) => item.type === "user_message" && item.messageId === steerId)
            ?.status,
          "cancelled",
        );
        assert.isTrue(
          after.turnItems.some(
            (item) => item.type === "system_notice" && item.message?.includes("Message steer"),
          ),
        );
        assert.deepEqual(yield* queuedOrder, [
          [MessageId.make("before"), true],
          [MessageId.make("after"), true],
        ]);
        return;
      }

      // Recovery cancels the run, holds the queue and leaves the unread steer pending.
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const now = yield* DateTime.now;
      yield* (yield* EventSink.EventSinkV2).write({
        commandId: CommandId.make("command:runtime-reconcile:startup:unread-steer"),
        events: projection.runs.map((run, index) => ({
          id: EventId.make(`recovered-run-${index}`),
          type: "run.updated" as const,
          threadId,
          runId: run.id,
          occurredAt: now,
          payload:
            run.id === parent.id
              ? { ...run, status: "cancelled" as const, completedAt: now }
              : { ...run, queueHeld: true },
        })),
      });
      yield* orchestrator.recoverDelegatedTasks;
      yield* worker.drain();
      assert.deepEqual(yield* queuedOrder, [
        [MessageId.make("before"), true],
        [steerId, true],
        [MessageId.make("after"), true],
      ]);
      assert.equal(offers.length, 2);
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          { name: "claude-unread-steer" },
          ProviderAdapterRegistry.layerSingle(adapter),
          { runEffectWorker: false },
        ),
      ),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        MemoryDerivedCache.layer,
        IdAllocator.layer,
        McpProviderSessions.layer,
        NodeServices.layer,
        NodeCrypto.layer,
      ),
    ),
  ),
);
