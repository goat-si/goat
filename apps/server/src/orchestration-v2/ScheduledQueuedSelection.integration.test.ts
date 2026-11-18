import { assert, it } from "@effect/vitest";
import { CommandId, EventId, MessageId, ScheduledTaskId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { nextTurnSelectionHarness, runSelection } from "./testkit/SteeringHarness.ts";

it.effect.each(["bound", "pinned", "legacy", "fresh_session", "promoted"] as const)(
  "delivers a %s scheduled message with its intended model",
  (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `scheduled-${scenario}`,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          const messageId = MessageId.make("message:scheduled");
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("command:scheduled"),
            threadId,
            messageId,
            text: "Scheduled follow-up",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            scheduledTaskId: ScheduledTaskId.make("schedule:queued"),
            ...(scenario === "pinned" ? { modelSelection: runSelection } : {}),
            ...(scenario === "fresh_session" ? { freshContext: true } : {}),
            createdBy: "agent",
            creationSource: "server",
          });
          const before = yield* orchestrator.getThreadProjection(threadId);
          const active = before.runs[0];
          const queued = before.runs.find((run) => run.userMessageId === messageId);
          const message = before.messages.find((row) => row.id === messageId);
          assert.equal(queued?.status, "queued");
          if (active === undefined || queued === undefined || message === undefined)
            return yield* Effect.die("Missing active or queued run");
          const latestSelection = { ...runSelection, model: "model-picked-while-queued" };
          const now = yield* DateTime.now;
          const afterSequence = yield* eventSink.latestSequence({ threadId });
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:picker"),
                type: "thread.model-selection-updated",
                threadId,
                occurredAt: now,
                payload: { ...before.thread, modelSelection: latestSelection, updatedAt: now },
              },
              ...(scenario === "legacy"
                ? [
                    {
                      id: EventId.make("event:legacy-message"),
                      type: "message.updated" as const,
                      threadId,
                      runId: queued.id,
                      occurredAt: now,
                      payload: { ...message, followsThreadSelection: undefined },
                    },
                  ]
                : []),
              ...(scenario === "promoted"
                ? []
                : [
                    {
                      id: EventId.make("event:active-completed"),
                      type: "run.updated" as const,
                      threadId,
                      runId: active.id,
                      occurredAt: now,
                      payload: { ...active, status: "completed" as const, completedAt: now },
                    },
                  ]),
            ],
          });
          if (scenario === "promoted") {
            yield* orchestrator.dispatch({
              type: "queued-message.promote-to-steer",
              commandId: CommandId.make("command:promote-scheduled"),
              threadId,
              queuedRunId: queued.id,
              targetRunId: active.id,
            });
            yield* worker.drain();
            assert.deepEqual(steered, ["Scheduled follow-up"]);
            const delivered = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(delivered.messages.find((row) => row.id === messageId)?.runId, active.id);
            assert.equal(
              delivered.messages.find((row) => row.id === messageId)?.followsThreadSelection,
              true,
            );
            return;
          }
          yield* eventSink.stream({ threadId, afterSequence, eventType: "run.updated" }).pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "run.updated" &&
                event.payload.id === queued.id &&
                event.payload.status === "starting",
            ),
            Stream.take(1),
            Stream.runDrain,
          );
          yield* worker.drain();
          assert.lengthOf(started, 2);
          assert.deepEqual(
            started[1]?.modelSelection,
            scenario === "pinned" || scenario === "legacy" ? runSelection : latestSelection,
          );
        }).pipe(Effect.provide(layer));
      }),
    ),
);
