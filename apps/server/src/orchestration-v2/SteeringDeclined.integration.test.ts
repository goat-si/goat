import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2Run,
  ProviderDriverKind,
  type RunId,
  type ThreadId,
} from "@goat/contracts";
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

// goat#3653: what ends a Stop's hold before a late decline arrives, and what does not.
type DeclineContext = {
  readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
  readonly worker: EffectWorker.OrchestrationEffectWorkerV2["Service"];
  readonly threadId: ThreadId;
  readonly firstRunId: RunId;
  /** Ends a run as interrupted and waits for the projection to record it. */
  readonly endRun: (runId: RunId) => Effect.Effect<void>;
  readonly started: ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>;
};

const stopHolding = (context: DeclineContext, id: string, runId = context.firstRunId) =>
  context.orchestrator
    .dispatch({
      type: "run.interrupt",
      commandId: CommandId.make(id),
      threadId: context.threadId,
      runId,
      holdQueue: true,
    })
    .pipe(Effect.asVoid, Effect.orDie);

const continuation = (context: DeclineContext, id: string, runId = context.firstRunId) =>
  ({
    type: "message.dispatch",
    commandId: CommandId.make(id),
    threadId: context.threadId,
    messageId: MessageId.make("message:" + id),
    text: "Continue where you left off.",
    attachments: [],
    manualContinuationOfRunId: runId,
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  }) as const;

const queuedFollowUp = (projection: { readonly runs: ReadonlyArray<OrchestrationV2Run> }) =>
  projection.runs.find((run) => run.userMessageId === MessageId.make("message:declined"));

/** Ends a run as interrupted, as its provider would, and waits until the projection records it. */
const endRunIn =
  (
    events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>,
    orchestrator: Orchestrator.OrchestratorV2["Service"],
    threadId: ThreadId,
  ) =>
  (runId: RunId) =>
    Effect.scoped(
      Effect.gen(function* () {
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const run = projection.runs.find((candidate) => candidate.id === runId)!;
        const turn = projection.providerTurns.findLast(
          (candidate) => candidate.runAttemptId === run.activeAttemptId,
        )!;
        const ended = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === runId &&
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
          runOrdinal: run.ordinal,
          status: "interrupted",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(ended);
      }),
    ).pipe(Effect.orDie);

/** A holding Stop on an idle worker: the provider ends the turn itself, and this waits for it. */
const stopAndEndIn =
  (
    orchestrator: Orchestrator.OrchestratorV2["Service"],
    worker: EffectWorker.OrchestrationEffectWorkerV2["Service"],
    threadId: ThreadId,
  ) =>
  (id: string, runId: RunId) =>
    Effect.scoped(
      Effect.gen(function* () {
        const ended = yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "run.updated" &&
              event.payload.id === runId &&
              event.payload.status === "interrupted",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make(id),
          threadId,
          runId,
          holdQueue: true,
        });
        yield* worker.drain();
        yield* Fiber.join(ended);
      }),
    ).pipe(Effect.orDie);

/** Steers the first turn; before runs just before the provider declines that steer. */
const declineAfter = <BeforeError, AfterError>(
  name: string,
  before: (context: DeclineContext) => Effect.Effect<void, BeforeError>,
  after: (
    context: DeclineContext & { readonly followUp: OrchestrationV2Run | undefined },
  ) => Effect.Effect<void, AfterError>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      let beforeDecline: Effect.Effect<void> = Effect.void;
      const { events, started, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        "steering-declined-" + name,
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
      return yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const endRun = endRunIn(events, orchestrator, threadId);
        const context: DeclineContext = {
          orchestrator,
          worker,
          threadId,
          firstRunId: started[0]!.runId,
          endRun,
          started,
        };
        beforeDecline = before(context).pipe(Effect.orDie);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("steer"),
          threadId,
          messageId: MessageId.make("message:declined"),
          text: "follow up",
          attachments: [],
          dispatchMode: { type: "steer_active", targetRunId: context.firstRunId },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const followUp = queuedFollowUp(yield* orchestrator.getThreadProjection(threadId));
        return yield* after({ ...context, followUp });
      }).pipe(Effect.provide(layer));
    }),
  );

it.effect(
  "regression goat#3653: after Stop and Resume a late decline's follow-up is not held, runs once, and holds nothing behind it",
  () =>
    declineAfter(
      "resume-then-decline",
      (context) =>
        Effect.gen(function* () {
          yield* stopHolding(context, "stop");
          yield* context.orchestrator
            .dispatch({
              type: "queue.resume",
              commandId: CommandId.make("resume"),
              threadId: context.threadId,
            })
            .pipe(Effect.orDie);
        }),
      (context) =>
        Effect.gen(function* () {
          const { worker } = context;
          assert.notEqual(context.followUp?.queueHeld, true);
          yield* context.orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("later"),
            threadId: context.threadId,
            messageId: MessageId.make("message:later"),
            text: "later",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "server",
          });
          yield* worker.drain();
          yield* context.orchestrator.resumeQueuedRuns;
          yield* worker.drain();
          const projection = yield* context.orchestrator.getThreadProjection(context.threadId);
          const later = projection.runs.find(
            (run) => run.userMessageId === MessageId.make("message:later"),
          );
          assert.notEqual(later?.queueHeld, true);
          assert.deepEqual(
            context.started.filter((turn) => turn.runId === context.followUp?.id).length,
            1,
          );
        }),
    ),
);

it.effect(
  "regression goat#3653: after Stop and a continuation of the stopped run a late decline's follow-up is not held",
  () =>
    declineAfter(
      "continue-then-decline",
      (context) =>
        Effect.gen(function* () {
          yield* stopHolding(context, "stop");
          yield* context.endRun(context.firstRunId);
          yield* context.orchestrator
            .dispatch(continuation(context, "continue"))
            .pipe(Effect.orDie);
        }),
      (context) =>
        Effect.sync(() => {
          assert.equal(context.followUp?.status, "queued");
          assert.notEqual(context.followUp?.queueHeld, true);
        }),
    ),
);

it.effect("a refused continuation leaves the Stop's hold, so a late decline is still held", () =>
  declineAfter(
    "refused-continuation",
    (context) =>
      Effect.gen(function* () {
        yield* stopHolding(context, "stop");
        // The stopped run has not ended, so it cannot be continued yet.
        const refused = yield* Effect.flip(
          context.orchestrator.dispatch(continuation(context, "continue-too-early")),
        );
        assert.include(String(refused.cause), "can no longer be resumed");
      }),
    (context) => Effect.sync(() => assert.equal(context.followUp?.queueHeld, true)),
  ),
);

it.effect("sending one queued message now leaves the Stop's hold", () =>
  declineAfter(
    "send-now-then-decline",
    (context) =>
      Effect.gen(function* () {
        yield* context.orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("queued"),
          threadId: context.threadId,
          messageId: MessageId.make("message:queued"),
          text: "queued",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* stopHolding(context, "stop");
        yield* context.endRun(context.firstRunId);
        const queued = (yield* context.orchestrator.getThreadProjection(
          context.threadId,
        )).runs.find((run) => run.userMessageId === MessageId.make("message:queued"))!;
        assert.equal(queued.queueHeld, true);
        yield* context.orchestrator
          .dispatch({
            type: "queued-run.start",
            commandId: CommandId.make("send-now"),
            threadId: context.threadId,
            runId: queued.id,
          })
          .pipe(Effect.orDie);
      }),
    (context) => Effect.sync(() => assert.equal(context.followUp?.queueHeld, true)),
  ),
);

it.effect(
  "a send while stopped and a continuation of a later run leave the earlier run's hold",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer, startFirstTurn, started } =
          yield* nextTurnSelectionHarness("stop-hold-other-run");
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          const stopAndEnd = stopAndEndIn(orchestrator, worker, threadId);
          const firstRunId = started[0]!.runId;
          const holds = (runId: RunId) =>
            orchestrator
              .getThreadProjection(threadId)
              .pipe(
                Effect.map((projection) =>
                  projection.turnItems.some(
                    (item) =>
                      item.type === "run_interrupt_request" &&
                      item.runId === runId &&
                      item.holdsQueue === true,
                  ),
                ),
              );
          yield* stopAndEnd("stop", firstRunId);
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("send-while-stopped"),
            threadId,
            messageId: MessageId.make("message:second"),
            text: "second",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          assert.isTrue(yield* holds(firstRunId));
          const secondRunId = started[1]!.runId;
          yield* stopAndEnd("stop-second", secondRunId);
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("continue-second"),
            threadId,
            messageId: MessageId.make("message:continue-second"),
            text: "Continue where you left off.",
            attachments: [],
            manualContinuationOfRunId: secondRunId,
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          assert.isFalse(yield* holds(secondRunId));
          assert.isTrue(yield* holds(firstRunId));
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect(
  "Resume and a continuation clear a hold once: nothing holding, or a receipt replay, writes nothing",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer, startFirstTurn, started } = yield* nextTurnSelectionHarness(
          "stop-hold-release-events",
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const threadId = yield* startFirstTurn;
          const runId = started[0]!.runId;
          const releasedRuns = (result: Orchestrator.OrchestratorV2DispatchResult) =>
            result.storedEvents.flatMap(({ event }) =>
              event.type === "turn-item.updated" && event.payload.type === "run_interrupt_request"
                ? [[event.payload.runId, "holdsQueue" in event.payload]]
                : [],
            );
          const resume = (id: string) =>
            orchestrator.dispatch({
              type: "queue.resume",
              commandId: CommandId.make(id),
              threadId,
            });
          const stop = (id: string) =>
            orchestrator.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make(id),
              threadId,
              runId,
              holdQueue: true,
            });

          assert.deepEqual(releasedRuns(yield* resume("resume-nothing-held")), []);
          yield* stop("stop");
          const resumed = yield* resume("resume");
          assert.deepEqual(releasedRuns(resumed), [[runId, false]]);
          const stored = (yield* orchestrator.getThreadProjection(threadId)).turnItems.find(
            (item) => item.type === "run_interrupt_request" && item.runId === runId,
          );
          assert.isDefined(stored);
          assert.isFalse("holdsQueue" in stored!);
          assert.deepEqual(releasedRuns(yield* resume("resume-again")), []);
          const replayedResume = yield* resume("resume");
          assert.isTrue(replayedResume.replayed);
          assert.deepEqual(replayedResume.storedEvents, resumed.storedEvents);

          yield* stopAndEndIn(
            orchestrator,
            yield* EffectWorker.OrchestrationEffectWorkerV2,
            threadId,
          )("stop-again", runId);
          const continueCommand = {
            type: "message.dispatch",
            commandId: CommandId.make("continue"),
            threadId,
            messageId: MessageId.make("message:continue"),
            text: "Continue where you left off.",
            attachments: [],
            manualContinuationOfRunId: runId,
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          } as const;
          const continued = yield* orchestrator.dispatch(continueCommand);
          assert.deepEqual(releasedRuns(continued), [[runId, false]]);
          const replayedContinue = yield* orchestrator.dispatch(continueCommand);
          assert.isTrue(replayedContinue.replayed);
          assert.deepEqual(replayedContinue.storedEvents, continued.storedEvents);
        }).pipe(Effect.provide(layer));
      }),
    ),
);
