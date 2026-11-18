import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as EventSink from "./EventSink.ts";
import {
  layerTest,
  providerInstanceId,
  modelSelection,
  makeThread,
  threadCreatedEvent,
} from "./FoundationPersistence.testkit.ts";

it.layer(layerTest)("handoff persistence", (it) => {
  it.effect("refuses a run-current write once an unpaired interrupt request is stored", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:foundation-interrupt-guard");
      const runId = RunId.make("run:foundation-interrupt-guard");
      const attemptId = RunAttemptId.make("run-attempt:foundation-interrupt-guard");
      const requestId = TurnItemId.make("turn-item:foundation-interrupt-guard:request");
      const resultId = TurnItemId.make("turn-item:foundation-interrupt-guard:result");
      const run: OrchestrationV2Run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:foundation-interrupt-guard"),
        rootNodeId: null,
        activeAttemptId: attemptId,
        status: "running",
        queuePosition: null,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      yield* eventSink.write({
        events: [
          threadCreatedEvent({
            id: "event:foundation-interrupt-guard:thread",
            thread: makeThread(threadId, now),
            now,
          }),
          {
            id: EventId.make("event:foundation-interrupt-guard:run"),
            type: "run.created",
            threadId,
            runId,
            providerInstanceId,
            occurredAt: now,
            payload: run,
          },
        ],
      });
      const signalItem = (id: TurnItemId, type: "run_interrupt_request" | "run_interrupt_result") =>
        ({
          id: EventId.make(`event:${id}`),
          type: "turn-item.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id,
            threadId,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed",
            title: "Interrupt",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type,
            message: "Stopped",
          },
        }) as OrchestrationV2DomainEvent;
      const completeRun = (suffix: string) =>
        eventSink.writeIfRunCurrent({
          threadId,
          runId,
          activeAttemptId: attemptId,
          expectedStatus: "running",
          unlessInterruptRequested: { requestId, resultId },
          events: [
            {
              id: EventId.make(`event:foundation-interrupt-guard:waiting:${suffix}`),
              type: "run.updated",
              threadId,
              runId,
              providerInstanceId,
              occurredAt: now,
              payload: { ...run, status: "waiting" },
            },
          ],
        });

      yield* eventSink.write({ events: [signalItem(requestId, "run_interrupt_request")] });
      const refused = yield* completeRun("refused");
      assert.isFalse(refused.committed);
      assert.deepEqual(refused.storedEvents, []);

      yield* eventSink.write({ events: [signalItem(resultId, "run_interrupt_result")] });
      assert.isTrue((yield* completeRun("paired")).committed);
    }).pipe(Effect.provide(Layer.fresh(layerTest))),
  );
});
