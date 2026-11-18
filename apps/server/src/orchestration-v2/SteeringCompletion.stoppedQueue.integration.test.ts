import { assert, it } from "@effect/vitest";
import { CommandId, MessageId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { nextTurnSelectionHarness, runSelection } from "./testkit/SteeringHarness.ts";

it.effect("queues a plain send behind the stopped queue and releases its hold", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("plain-send-after-stop");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const send = (id: string, delivery: "queue" | "auto") =>
          orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(id),
            threadId,
            messageId: MessageId.make(`message:${id}`),
            text: id,
            attachments: [],
            modelSelection: runSelection,
            ...(delivery === "queue"
              ? { dispatchMode: { type: "queue_after_active" } }
              : { dispatchMode: { type: "start_immediately" }, deliveryIntent: "auto" }),
            createdBy: "user",
            creationSource: "web",
          });
        yield* send("queued", "queue");
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop"),
          threadId,
          runId: started[0]!.runId,
          holdQueue: true,
        });
        // The provider has not stopped yet, so a plain send still resolves to a steer.
        yield* send("sent", "auto");

        // Read the queue before the worker delivers Stop: once the provider stops,
        // the released queue starts its next run.
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(steered, []);
        assert.equal(started.length, 1);
        const queued = projection.runs
          .filter((run) => run.status === "queued")
          .sort((left, right) => (left.queuePosition ?? 0) - (right.queuePosition ?? 0));
        const textOf = (run: (typeof projection.runs)[number]) =>
          projection.messages.find((message) => message.id === run.userMessageId)?.text;
        assert.deepEqual(queued.map(textOf), ["queued", "sent"]);
        // The user sent it, so the queue they stopped runs again once the provider stops.
        assert.isFalse(queued.some((run) => run.queueHeld === true));

        // The run-update reactor starts the next queued run on its own fiber, and
        // that commit carries the start effect, so drain again once it lands.
        const resumed = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.runId === queued[0]!.id &&
              event.payload.status !== "queued",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* worker.drain();
        yield* Fiber.join(resumed);
        yield* worker.drain();
        assert.deepEqual(steered, []);
        assert.deepEqual(
          started.map((turn) => turn.runId),
          [started[0]!.runId, queued[0]!.id],
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);
