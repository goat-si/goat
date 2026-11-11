import { assert, it } from "@effect/vitest";
import { CommandId, EventId, MessageId, ProviderInstanceId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { nextTurnSelectionHarness, runSelection } from "./testkit/SteeringHarness.ts";

const instanceId = ProviderInstanceId.make("codex");

const composerSelection = {
  ...runSelection,
  options: [...runSelection.options, { id: "fastMode", value: false }],
};

/**
 * A background command result reaches the turn a Codex goal is driving. Without an active goal it
 * waits in the queue like any other server notice.
 */
it.effect.each([
  { name: "active-goal", goal: "active" as const, steers: true },
  { name: "no-goal", goal: null, steers: false },
  { name: "paused-goal", goal: "paused" as const, steers: false },
])(
  "$name: a background command notice joins the running turn only under an active goal",
  (testCase) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `command-notice-${testCase.name}`,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const sink = yield* EventSink.EventSinkV2;
          const threadId = yield* startFirstTurn;
          const { thread } = yield* orchestrator.getThreadProjection(threadId);
          yield* sink.write({
            events: [
              {
                id: EventId.make(`event:${testCase.name}:composer-selection`),
                type: "thread.model-selection-updated",
                threadId,
                providerInstanceId: instanceId,
                occurredAt: yield* DateTime.now,
                payload: { ...thread, modelSelection: composerSelection },
              },
            ],
          });
          if (testCase.goal !== null) {
            const providerThread = (yield* orchestrator.getThreadProjection(threadId))
              .providerThreads[0]!;
            yield* sink.write({
              events: [
                {
                  id: EventId.make(`event:${testCase.name}:goal`),
                  type: "provider-thread.updated",
                  threadId,
                  occurredAt: yield* DateTime.now,
                  payload: {
                    ...providerThread,
                    goal: { objective: "Ship it", status: testCase.goal },
                  },
                },
              ],
            });
          }
          const messageId = MessageId.make(`message:${testCase.name}`);
          const notification = {
            source: { kind: "command" as const },
            outcome: "completed" as const,
            summary: "Background command finished",
          };
          const text = `${notification.summary}\nexit 0: built 12 files`;
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`notice-${testCase.name}`),
            threadId,
            messageId,
            text,
            notification,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "server",
          });
          yield* worker.drain();

          const after = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(steered, testCase.steers ? [text] : []);
          assert.lengthOf(started, 1);
          assert.equal(
            after.runs.some((run) => run.status === "queued"),
            !testCase.steers,
          );
          const message = after.messages.find((candidate) => candidate.id === messageId);
          assert.deepEqual(message?.notification, notification);
          if (testCase.steers) assert.equal(message?.runId, started[0]?.runId);
          assert.deepEqual(after.thread.modelSelection, composerSelection);
        }).pipe(Effect.provide(layer));
      }),
    ),
);
