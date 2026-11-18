import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ProviderDriverKind } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { nextTurnSelectionHarness, runSelection } from "./testkit/SteeringHarness.ts";

const driver = ProviderDriverKind.make("codex");

// regression: #32891 a restart that Stop already reached is lost
it.effect("refuses a steer but starts a restart sent into a run that Stop reached", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } =
        yield* nextTurnSelectionHarness("restart-after-stop");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        // The worker has not delivered the interrupt yet, so the run still reads as running.
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop"),
          threadId,
          runId: first.runId,
        });
        const steerError = yield* orchestrator
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("steer"),
            threadId,
            messageId: MessageId.make("message:steer"),
            text: "steer",
            attachments: [],
            modelSelection: runSelection,
            dispatchMode: { type: "steer_active", targetRunId: first.runId },
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(Effect.flip);
        assert.equal(steerError._tag, "OrchestratorDispatchError");
        assert.include(String(steerError.cause), "is stopping and cannot be steered");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("restart"),
          threadId,
          messageId: MessageId.make("message:restart"),
          text: "restart",
          attachments: [],
          modelSelection: runSelection,
          dispatchMode: { type: "restart_active", targetRunId: first.runId },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();

        assert.deepEqual(steered, []);
        assert.deepEqual(
          started.map((turn) => turn.message.text),
          ["first", "restart"],
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

// regression: #32891 a restart that arrives after the turn ended is lost
it.effect.each([
  { status: "completed", settled: true },
  { status: "completed", settled: false },
  { status: "interrupted", settled: true },
  { status: "interrupted", settled: false },
  { status: "cancelled", settled: false },
] as const)(
  "starts a restart that missed the turn ($status, run settled: $settled) as a new turn",
  ({ status, settled: runSettled }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `restart-after-${status}-${runSettled ? "settled" : "unsettled"}`,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          const first = started[0]!;
          const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
          const turnEnded = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "provider-turn.updated" &&
                event.payload.id === turn.id &&
                event.payload.status === status,
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: { ...turn, status, completedAt: yield* DateTime.now },
          });
          yield* Fiber.join(turnEnded);
          const settleRun = Effect.gen(function* () {
            const settled = yield* orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (event) =>
                  event.type === "run.updated" &&
                  event.payload.id === first.runId &&
                  event.payload.status !== "running",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
            yield* Queue.offer(events, {
              type: "turn.terminal",
              driver,
              providerThreadId: turn.providerThreadId,
              providerTurnId: turn.id,
              runOrdinal: first.runOrdinal,
              status,
              failure: null,
              threadDisposition: "reusable",
            });
            yield* Fiber.join(settled);
            yield* worker.drain();
          });
          if (runSettled) yield* settleRun;

          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("restart"),
            threadId,
            messageId: MessageId.make("message:restart"),
            text: "restart",
            attachments: [],
            modelSelection: runSelection,
            dispatchMode: { type: "restart_active", targetRunId: first.runId },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          if (!runSettled) {
            const restartLeftQueue = yield* orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (event) =>
                  event.type === "run.updated" &&
                  event.payload.userMessageId === "message:restart" &&
                  event.payload.status !== "queued",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
            yield* settleRun;
            yield* Fiber.join(restartLeftQueue);
            yield* worker.drain();
          }

          assert.deepEqual(steered, []);
          assert.deepEqual(
            started.map((turn) => turn.message.text),
            ["first", "restart"],
          );
        }).pipe(Effect.provide(layer));
      }),
    ),
);

// regression: #32891 a restart into a failed provider turn is lost
it.effect("queues a restart sent into a provider turn that failed before its run settled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { events, started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "restart-after-failed-unsettled",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
        const turnFailed = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "provider-turn.updated" &&
              event.payload.id === turn.id &&
              event.payload.status === "failed",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "failed", completedAt: yield* DateTime.now },
        });
        yield* Fiber.join(turnFailed);

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("restart"),
          threadId,
          messageId: MessageId.make("message:restart"),
          text: "restart",
          attachments: [],
          modelSelection: runSelection,
          dispatchMode: { type: "restart_active", targetRunId: first.runId },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();

        assert.deepEqual(steered, []);
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          projection.runs.find((run) => run.userMessageId === "message:restart")?.status,
          "queued",
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);
