import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ProviderDriverKind } from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { nextTurnSelectionHarness, runSelection } from "./testkit/SteeringHarness.ts";

const driver = ProviderDriverKind.make("codex");
const composerSelection = {
  ...runSelection,
  options: [...runSelection.options, { id: "fastMode", value: false }],
};

type EarlierInterrupt =
  | { readonly kind: "run"; readonly holdQueue: boolean; readonly reason?: string }
  | { readonly kind: "thread"; readonly reason: string }
  // Ingestion ends the run outside the effect queue, so no run is active at dispatch.
  | { readonly kind: "run ends" };
const agentInterrupt: EarlierInterrupt = {
  kind: "run",
  holdQueue: false,
  reason: "Stopped by an agent",
};
const personStop: EarlierInterrupt = { kind: "run", holdQueue: true };
// The follow-up is held only when an interrupt request on the steered run held the queue.
const INTERRUPTS_BEFORE_DECLINE = {
  "agent thread.stop before decline": {
    interrupts: [{ kind: "thread", reason: "Stopped by an agent: done" }],
    holds: true,
  },
  "agent interrupt before decline": { interrupts: [agentInterrupt], holds: false },
  "goal worker interrupt before decline": {
    interrupts: [
      { kind: "run", holdQueue: false, reason: "The fleet goal no longer needs this worker." },
    ],
    holds: false,
  },
  // Byte for byte the item an older build wrote for a Stop: no holdsQueue, the default message.
  "interrupt item without holdsQueue before decline": {
    interrupts: [{ kind: "run", holdQueue: false }],
    holds: false,
  },
  "unheld then held interrupt before decline": {
    interrupts: [agentInterrupt, personStop],
    holds: true,
  },
  "held then unheld interrupt before decline": {
    interrupts: [personStop, agentInterrupt],
    holds: true,
  },
  "stop, then the run ends before decline": {
    interrupts: [personStop, { kind: "run ends" }],
    holds: true,
  },
  // A holding thread.stop that finds the run ended reaches it only through markStoppedRun.
  "agent interrupt, the run ends, then an agent thread.stop before decline": {
    interrupts: [
      agentInterrupt,
      { kind: "run ends" },
      { kind: "thread", reason: "Stopped by an agent: done" },
    ],
    holds: true,
  },
} satisfies Record<
  string,
  { readonly interrupts: ReadonlyArray<EarlierInterrupt>; readonly holds: boolean }
>;
type InterruptTiming = keyof typeof INTERRUPTS_BEFORE_DECLINE;
const isInterruptTiming = (timing: string): timing is InterruptTiming =>
  Object.hasOwn(INTERRUPTS_BEFORE_DECLINE, timing);

it.effect.each([
  "complete",
  "stop-before-decline",
  "stop-before-decline, discarded",
  "stop-after-decline",
  "queued-model",
  ...(Object.keys(INTERRUPTS_BEFORE_DECLINE) as Array<InterruptTiming>),
] as const)("persists a declined steer without blocking the worker: %s", (timing) =>
  Effect.scoped(
    Effect.gen(function* () {
      let beforeDecline: Effect.Effect<void> = Effect.void;
      const { events, started, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        `steering-declined-${timing}`,
        false,
        Effect.void,
        false,
        undefined,
        true,
        {},
        undefined,
        (turn) =>
          Effect.suspend(() => beforeDecline).pipe(
            Effect.andThen(
              Effect.fail(
                new ProviderAdapter.ProviderAdapterSteerDeclinedError({
                  driver,
                  providerThreadId: turn.providerThread.id,
                  providerTurnId: turn.providerTurnId,
                }),
              ),
            ),
          ),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const first = started[0]!;
        const stop = orchestrator
          .dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("stop"),
            threadId,
            runId: first.runId,
            holdQueue: true,
          })
          .pipe(Effect.asVoid, Effect.orDie);
        if (timing.startsWith("stop-before-decline")) beforeDecline = stop;
        if (isInterruptTiming(timing)) {
          const endRun = Effect.gen(function* () {
            const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
            const ended = yield* orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (event) =>
                  event.type === "run.updated" &&
                  event.payload.id === first.runId &&
                  event.payload.status === "interrupted",
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
              status: "interrupted",
              failure: null,
              threadDisposition: "reusable",
            });
            yield* Fiber.join(ended);
          });
          beforeDecline = Effect.forEach(
            INTERRUPTS_BEFORE_DECLINE[timing].interrupts,
            (interrupt: EarlierInterrupt, index) =>
              interrupt.kind === "run ends"
                ? Effect.scoped(endRun)
                : orchestrator.dispatch(
                    interrupt.kind === "thread"
                      ? {
                          type: "thread.stop",
                          commandId: CommandId.make(`earlier-interrupt-${index}`),
                          threadId,
                          reason: interrupt.reason,
                          stopDelegatedTasks: false,
                        }
                      : {
                          type: "run.interrupt",
                          commandId: CommandId.make(`earlier-interrupt-${index}`),
                          threadId,
                          runId: first.runId,
                          ...(interrupt.holdQueue ? { holdQueue: true } : {}),
                          ...(interrupt.reason === undefined ? {} : { reason: interrupt.reason }),
                        },
                  ),
          ).pipe(Effect.asVoid, Effect.orDie);
        }
        const steerSelection = { ...runSelection, model: "steer-model" };
        if (timing === "queued-model") {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("queued-model"),
            threadId,
            messageId: MessageId.make("message:queued-model"),
            text: "already queued",
            attachments: [],
            modelSelection: composerSelection,
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
          beforeDecline = Effect.forEach(["queued-later", "steer-later", "queued-last"], (id) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(id),
              threadId,
              messageId: MessageId.make(`message:${id}`),
              text: id,
              attachments: [],
              dispatchMode:
                id === "steer-later"
                  ? { type: "steer_active", targetRunId: first.runId }
                  : { type: "queue_after_active" },
              createdBy: "user",
              creationSource: "web",
            }),
          ).pipe(Effect.asVoid, Effect.orDie);
        }
        const messageId = MessageId.make("message:declined");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer"),
          threadId,
          messageId,
          text: "follow up",
          attachments: [],
          ...(timing === "queued-model" ? { modelSelection: steerSelection } : {}),
          dispatchMode: { type: "steer_active", targetRunId: first.runId },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const pending = yield* orchestrator.getThreadProjection(threadId);
        const queued = pending.runs.find(
          (run) => run.userMessageId === messageId && run.id !== first.runId,
        );
        const effects = yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(
          CommandId.make("steer"),
        );
        assert.deepEqual(
          effects.map((effect) => [effect.request.type, effect.status]),
          [["provider-turn.steer", "succeeded"]],
        );
        if (isInterruptTiming(timing)) {
          const { holds } = INTERRUPTS_BEFORE_DECLINE[timing];
          assert.equal(queued?.queueHeld === true, holds);
          if (holds) assert.equal(queued?.status, "queued");
          // After an interrupt that did not hold the queue the follow-up starts once, unheld.
          yield* worker.drain();
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();
          assert.deepEqual(
            started.map((turn) => turn.runId),
            holds ? [first.runId] : [first.runId, queued?.id],
          );
          return;
        }
        assert.equal(started.length, 1);
        assert.equal(queued?.status, "queued");
        assert.equal(queued?.userMessageId, messageId);
        assert.isFalse(
          pending.visibleTurnItems.some(
            ({ item }) => item.type === "user_message" && item.messageId === messageId,
          ),
          "a declined steer waiting in the queue must not appear delivered",
        );
        if (timing.startsWith("stop-before-decline")) {
          // Stop already held the queue, so the follow-up waits there for the person to resume it.
          assert.equal(queued?.queueHeld, true);
          const followUps = (projection: typeof pending) =>
            projection.runs
              .filter((run) => run.userMessageId === messageId && run.id !== first.runId)
              .map((run) => [run.id, run.status, run.queueHeld === true]);
          // Neither a second Stop, a replayed decline, a mode or model change nor a restart starts it.
          yield* orchestrator
            .dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("stop-again"),
              threadId,
              runId: first.runId,
              holdQueue: true,
            })
            .pipe(Effect.ignore);
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("command:steer-follow-up:replay"),
            threadId,
            messageId,
            steerFollowUpOfRunId: first.runId,
            text: "follow up",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* orchestrator.dispatch({
            type: "thread.runtime-mode.set",
            commandId: CommandId.make("mode"),
            threadId,
            runtimeMode: "full-access",
          });
          yield* orchestrator.dispatch({
            type: "thread.model-selection.set",
            commandId: CommandId.make("model"),
            threadId,
            modelSelection: { ...runSelection, model: "other-model" },
          });
          yield* worker.drain();
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();
          assert.deepEqual(followUps(yield* orchestrator.getThreadProjection(threadId)), [
            [queued?.id, "queued", true],
          ]);
          assert.equal(started.length, 1);
          const queuedRunId = queued?.id;
          if (queuedRunId === undefined) return;
          yield* orchestrator.dispatch(
            timing === "stop-before-decline"
              ? { type: "queue.resume", commandId: CommandId.make("resume"), threadId }
              : {
                  type: "queued-run.cancel",
                  commandId: CommandId.make("discard"),
                  threadId,
                  runId: queuedRunId,
                },
          );
          yield* worker.drain();
          yield* orchestrator
            .dispatch({ type: "queue.resume", commandId: CommandId.make("resume-again"), threadId })
            .pipe(Effect.ignore);
          yield* worker.drain();
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();
          const settled = yield* orchestrator.getThreadProjection(threadId);
          if (timing === "stop-before-decline") {
            assert.deepEqual(
              started.map((turn) => turn.runId),
              [first.runId, queuedRunId],
            );
          } else {
            assert.equal(started.length, 1);
            assert.equal(settled.runs.find((run) => run.id === queuedRunId)?.status, "cancelled");
          }
          return;
        }
        if (timing === "queued-model") {
          assert.deepEqual(queued?.modelSelection, steerSelection);
          assert.deepEqual(
            pending.runs
              .filter((run) => run.status === "queued")
              .toSorted(
                (left, right) =>
                  (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal),
              )
              .map((run) => run.userMessageId),
            [
              MessageId.make("message:queued-model"),
              messageId,
              MessageId.make("message:queued-later"),
              MessageId.make("message:steer-later"),
              MessageId.make("message:queued-last"),
            ],
          );
          return;
        }
        if (timing === "stop-after-decline") {
          yield* stop;
          yield* worker.drain();
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();
          const held = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(held.runs.find((run) => run.id === queued?.id)?.queueHeld, true);
          assert.equal(started.length, 1);
          return;
        }
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
        const turn = pending.providerTurns[0]!;
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
        assert.equal(started.length, 2);
        assert.equal(started[1]?.message.messageId, messageId);
        assert.equal(started[1]?.runId, queued?.id);
      }).pipe(Effect.provide(layer));
    }),
  ),
);
