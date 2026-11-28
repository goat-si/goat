import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { nextTurnSelectionHarness } from "./testkit/SteeringHarness.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");

// regression: #41509 a declined steer of a delegated completion wake must still queue the wake
it.effect("queues a delegated completion wake whose steer the provider declined", () =>
  Effect.gen(function* () {
    const { events, started, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
      "steering-declined-delegated-completion",
      false,
      Effect.void,
      false,
      undefined,
      true,
      {},
      undefined,
      (turn) =>
        Effect.fail(
          new ProviderAdapter.ProviderAdapterSteerDeclinedError({
            driver,
            providerThreadId: turn.providerThread.id,
            providerTurnId: turn.providerTurnId,
          }),
        ),
    );
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = yield* startFirstTurn;
      const first = started[0]!;
      const messageId = MessageId.make("message:declined-wake");
      const taskId = NodeId.make("task:declined-wake");
      const parentRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.id === first.runId,
      )!;
      const now = yield* DateTime.now;
      yield* (yield* EventSink.EventSinkV2).write({
        events: [
          {
            id: EventId.make("event:declined-wake:cohort"),
            type: "run.updated",
            threadId,
            runId: first.runId,
            occurredAt: now,
            payload: {
              ...parentRun,
              delegatedCompletion: {
                disposition: "open",
                nextGeneration: 2,
                delivery: { generation: 1, messageId, taskIds: [taskId] },
              },
            },
          },
          {
            id: EventId.make("event:declined-wake:task"),
            type: "subagent.updated",
            threadId,
            runId: first.runId,
            nodeId: taskId,
            occurredAt: now,
            payload: {
              id: taskId,
              threadId,
              runId: first.runId,
              parentNodeId: first.rootNodeId,
              origin: "app_owned",
              createdBy: "agent",
              driver,
              providerInstanceId: instanceId,
              providerThreadId: null,
              childThreadId: null,
              nativeTaskRef: null,
              prompt: "Do background work",
              title: "Background test",
              model: null,
              completionWake: "always",
              completionDelivery: { state: "claimed", observedByRunId: null },
              status: "completed",
              result: "done",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
            },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("wake"),
        threadId,
        messageId,
        text: "Delegated task completed",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        delegatedCompletion: { parentRunId: first.runId, generation: 1, taskIds: [taskId] },
        createdBy: "agent",
        creationSource: "server",
      });
      yield* worker.drain();
      const effects = yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(
        CommandId.make("wake"),
      );
      assert.deepEqual(
        effects.map((effect) => [effect.request.type, effect.status]),
        [["provider-turn.steer", "succeeded"]],
        "the declined steer's queue fallback was rejected",
      );
      const pending = yield* orchestrator.getThreadProjection(threadId);
      const queued = pending.runs.find(
        (run) => run.userMessageId === messageId && run.id !== first.runId,
      );
      assert.equal(queued?.status, "queued");

      const turn = pending.providerTurns[0]!;
      const settled = yield* orchestrator.streamDomainEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === first.runId &&
            event.payload.status === "waiting",
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped,
      );
      yield* Queue.offer(events, {
        type: "provider_turn.updated",
        driver,
        providerTurn: { ...turn, status: "completed", completedAt: yield* DateTime.now },
      });
      yield* Queue.offer(events, {
        type: "turn.terminal",
        driver,
        providerThreadId: turn.providerThreadId,
        providerTurnId: turn.id,
        runOrdinal: first.runOrdinal,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      });
      yield* Fiber.join(settled);
      yield* worker.drain();
      yield* orchestrator.resumeQueuedRuns;
      yield* worker.drain();
      assert.equal(started[1]?.message.messageId, messageId, "the parent was never woken");
    }).pipe(Effect.provide(layer));
  }),
);
