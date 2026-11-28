import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ProviderDriverKind, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { nextTurnSelectionHarness } from "./testkit/SteeringHarness.ts";
const driver = ProviderDriverKind.make("codex");

// regression: #39404 a later agent message steers ahead of one queued behind /compact
it.effect("delivers agent messages queued behind /compact before a later one steers", () =>
  Effect.gen(function* () {
    const { events, started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
      "agent-order-after-compact",
    );
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = yield* startFirstTurn;
      const nextRunning = Effect.fn("nextRunning")(function* () {
        return yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
      });
      const lock = (yield* ThreadCommandExecutor.ThreadCommandExecutor).withLock(
        threadId,
        Effect.void,
      );
      const finishTurn = Effect.fn("finishTurn")(function* (index: number) {
        const turnInput = started[index]!;
        const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns.find(
          (candidate) => candidate.runAttemptId === turnInput.attemptId,
        )!;
        const settled = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === turnInput.runId &&
              (event.payload.status === "waiting" || event.payload.status === "completed"),
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
          runOrdinal: turnInput.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(settled);
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
      });
      yield* finishTurn(0);
      const compactRunning = yield* nextRunning();
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("compact"),
        threadId,
        messageId: MessageId.make("message:compact"),
        text: "/compact",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();
      yield* Fiber.join(compactRunning);
      yield* lock;
      const sendFromAgent = (codeword: string) =>
        Effect.gen(function* () {
          const active = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.status === "running",
          )!;
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`send-${codeword}`),
            threadId,
            messageId: MessageId.make(`message:${codeword}`),
            text: codeword,
            attachments: [],
            dispatchMode: { type: "steer_active", targetRunId: active.id },
            deliveryIntent: "auto",
            createdBy: "agent",
            creationSource: "mcp",
            senderThreadId: ThreadId.make("thread:orchestrator"),
          });
          yield* worker.drain();
        });
      yield* sendFromAgent("ALPHA");
      yield* sendFromAgent("BRAVO");
      const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.filter(
        (run) => run.status === "queued",
      );
      assert.lengthOf(queued, 2);
      assert.deepEqual(steered, []);

      const alphaRunning = yield* nextRunning();
      yield* finishTurn(1);
      yield* Fiber.join(alphaRunning);
      yield* lock;
      assert.deepEqual(
        started.map((turn) => turn.message.text.split("\n").at(-1)),
        ["first", "/compact", "ALPHA"],
      );

      yield* sendFromAgent("CHARLIE");
      const delivered = [...steered, ...started.slice(3).map((turn) => turn.message.text)]
        .map((text) => text.split("\n").at(-1))
        .filter((text) => text === "BRAVO" || text === "CHARLIE");
      // Whatever reaches the agent so far does so in send order: CHARLIE never before BRAVO.
      assert.deepEqual(delivered, ["BRAVO", "CHARLIE"].slice(0, delivered.length));
    }).pipe(Effect.provide(layer));
  }),
);
