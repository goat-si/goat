import { assert, it } from "@effect/vitest";
import { CommandId, EventId, MessageId, RunAttemptId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";
import * as Stream from "effect/Stream";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { runDeferredSteeringReactor } from "./goat/DeferredSteering.ts";
import { LIVE_STREAM_MAX_ITEMS } from "./LiveStreamBudget.ts";
import { nextTurnSelectionHarness, runSelection } from "./testkit/SteeringHarness.ts";

it.effect.each([
  { mode: "direct", outcome: "steered" },
  { mode: "promoted", outcome: "steered" },
  { mode: "direct", outcome: "ended" },
  { mode: "promoted", outcome: "replaced" },
  { mode: "direct", outcome: "denied" },
] as const)("defers a $mode steer until its setup attempt is $outcome", ({ mode, outcome }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
        `deferred-steer-${mode}-${outcome}`,
        false,
        Effect.void,
        outcome === "denied",
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* startFirstTurn;
        const {
          runs: [run],
          providerTurns: [turn],
        } = yield* orchestrator.getThreadProjection(threadId);
        assert.isDefined(run?.activeAttemptId);
        assert.isDefined(turn);
        if (!run || !turn) return;
        const now = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("event:setup-run"),
              type: "run.updated",
              threadId,
              runId: run.id,
              occurredAt: now,
              payload: { ...run, status: mode === "direct" ? "preparing" : "starting" },
            },
            {
              id: EventId.make("event:setup-turn"),
              type: "provider-turn.updated",
              threadId,
              runId: run.id,
              occurredAt: now,
              payload: { ...turn, status: "pending" },
            },
          ],
        });
        const messageId = MessageId.make("message:deferred");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("command:deferred"),
          threadId,
          messageId,
          text: "Follow up during setup",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          ...(mode === "direct" ? { deliveryIntent: "steer" as const } : {}),
          ...(outcome === "denied"
            ? { modelSelection: { ...runSelection, model: "requires-restart" } }
            : {}),
          createdBy: "user",
          creationSource: "web",
        });
        const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (candidate) => candidate.userMessageId === messageId,
        );
        assert.equal(queued?.status, "queued");
        if (!queued) return;
        if (mode === "promoted") {
          yield* orchestrator.dispatch({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make("command:promote"),
            threadId,
            queuedRunId: queued.id,
            targetRunId: run.id,
          });
        }
        assert.deepEqual(steered, []);
        const attempt =
          outcome === "replaced" ? RunAttemptId.make("attempt:replaced") : turn.runAttemptId;
        if (outcome === "replaced") {
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:replaced-run"),
                type: "run.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: { ...run, status: "starting", activeAttemptId: attempt },
              },
            ],
          });
        }
        const probeId = MessageId.make("message:valid-steer");
        const sendsProbe = outcome === "replaced" || outcome === "denied";
        if (sendsProbe) {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("command:probe"),
            threadId,
            messageId: probeId,
            text: "Feasible follow-up",
            attachments: [],
            dispatchMode: { type: "steer_active", targetRunId: run.id },
            modelSelection: runSelection,
            createdBy: "user",
            creationSource: "web",
          });
        }
        if (outcome !== "ended") {
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:ready-run"),
                type: "run.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: { ...run, activeAttemptId: attempt },
              },
              ...["ready", "duplicate-ready"].map((key) => ({
                id: EventId.make(`event:${key}`),
                type: "provider-turn.updated" as const,
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: { ...turn, runAttemptId: attempt },
              })),
            ],
          });
        }
        if (outcome !== "ended") {
          const expectedMessageId = sendsProbe ? probeId : messageId;
          yield* eventSink
            .stream({ threadId, afterSequence: 0, eventType: "message.updated" })
            .pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "message.updated" &&
                  event.payload.id === expectedMessageId &&
                  event.payload.runId === run.id,
              ),
              Stream.take(1),
              Stream.runDrain,
            );
          yield* worker.drain();
          assert.deepEqual(steered, [sendsProbe ? "Feasible follow-up" : "Follow up during setup"]);
          assert.lengthOf(started, 1);
          if (outcome === "steered") return;
        }
        const afterSequence = yield* eventSink.latestSequence({ threadId });
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("event:ended-run"),
              type: "run.updated",
              threadId,
              runId: run.id,
              occurredAt: now,
              payload: { ...run, activeAttemptId: attempt, status: "completed", completedAt: now },
            },
          ],
        });
        yield* eventSink.stream({ threadId, afterSequence, eventType: "run.updated" }).pipe(
          Stream.filter(
            ({ event }) =>
              event.type === "run.updated" &&
              event.payload.id === queued.id &&
              event.payload.queueHeld === true,
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        assert.deepEqual(steered, sendsProbe ? ["Feasible follow-up"] : []);
        assert.lengthOf(started, 1);
        const held = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(held.runs.find((candidate) => candidate.id === queued.id)?.status, "queued");
        yield* orchestrator.dispatch({
          type: "queued-run.start",
          commandId: CommandId.make("command:send-held"),
          threadId,
          runId: queued.id,
        });
        yield* worker.drain();
        assert.deepEqual(
          started.map((input) => input.message.text),
          ["first", "Follow up during setup"],
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect.each(["completed", "interrupted", "replaced"] as const)(
  "holds a promoted setup steer when its attempt is %s before the outbox delivers it",
  (outcome) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
          `deferred-steer-outbox-${outcome}`,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = yield* startFirstTurn;
          const {
            runs: [run],
            providerTurns: [turn],
          } = yield* orchestrator.getThreadProjection(threadId);
          if (!run || !turn || turn.runAttemptId === null)
            return yield* Effect.die("Missing running turn");
          const now = yield* DateTime.now;
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:setup-run"),
                type: "run.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: { ...run, status: "starting" },
              },
            ],
          });
          const messageId = MessageId.make("message:deferred-outbox");
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("command:deferred-outbox"),
            threadId,
            messageId,
            text: "Steer only the setup attempt",
            attachments: [],
            dispatchMode: { type: "steer_active", targetRunId: run.id },
            createdBy: "user",
            creationSource: "web",
          });
          const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (row) => row.userMessageId === messageId,
          );
          if (!queued) return yield* Effect.die("Missing deferred run");
          const afterSequence = yield* eventSink.latestSequence({ threadId });
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:ready-run"),
                type: "run.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: run,
              },
              {
                id: EventId.make("event:ready-turn"),
                type: "provider-turn.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: turn,
              },
            ],
          });
          yield* eventSink.stream({ threadId, afterSequence, eventType: "message.updated" }).pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "message.updated" &&
                event.payload.id === messageId &&
                event.payload.runId === run.id,
            ),
            Stream.take(1),
            Stream.runDrain,
          );
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:lost-run"),
                type: "run.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload:
                  outcome === "replaced"
                    ? { ...run, activeAttemptId: RunAttemptId.make("attempt:replacement") }
                    : { ...run, status: outcome, completedAt: now },
              },
              ...(outcome === "replaced"
                ? []
                : [
                    {
                      id: EventId.make("event:lost-turn"),
                      type: "provider-turn.updated" as const,
                      threadId,
                      runId: run.id,
                      occurredAt: now,
                      payload: { ...turn, status: outcome, completedAt: now },
                    },
                  ]),
            ],
          });
          yield* worker.drain();
          assert.deepEqual(
            started.map((input) => input.message.text),
            ["first"],
          );
          assert.deepEqual(steered, []);
          const held = yield* orchestrator.getThreadProjection(threadId);
          assert.include(
            held.runs.find((row) => row.id === queued.id),
            {
              status: "queued",
              queueHeld: true,
              steerWhenReadyAttemptId: turn.runAttemptId,
            },
          );
          assert.equal(held.messages.find((row) => row.id === messageId)?.runId, queued.id);
          const item = held.turnItems.find(
            (row) => row.type === "user_message" && row.messageId === messageId,
          );
          assert.include(item, { runId: queued.id, inputIntent: "queued_turn", status: "pending" });

          if (outcome !== "replaced") {
            yield* orchestrator.dispatch({
              type: "queued-run.start",
              commandId: CommandId.make("command:send-restored"),
              threadId,
              runId: queued.id,
            });
            yield* worker.drain();
            assert.deepEqual(
              started.map((input) => input.message.text),
              ["first", "Steer only the setup attempt"],
            );
          }
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect(
  "catches up from its last handled event when a stalled deferred-steer reactor overflows",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer, startFirstTurn } =
          yield* nextTurnSelectionHarness("deferred-steer-overflow");
        yield* Effect.gen(function* () {
          const sink = yield* EventSink.EventSinkV2;
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
          const threadId = yield* startFirstTurn;
          const {
            providerTurns: [turn],
          } = yield* orchestrator.getThreadProjection(threadId);
          if (turn === undefined) return yield* Effect.die("Missing provider turn");

          const stalled = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const caughtUp = yield* Deferred.make<void>();
          const overflow = yield* Deferred.make<void>();
          const logger = Logger.make(({ message }) => {
            if (JSON.stringify(message).includes("orchestration live event buffer is full"))
              Deferred.doneUnsafe(overflow, Effect.void);
          });
          const cursors: number[] = [];
          let bounded: boolean | undefined;
          let handled = 0;
          const initialCursor = yield* sink.latestSequence();
          yield* runDeferredSteeringReactor(
            initialCursor,
            {
              stream: (input) => {
                cursors.push(input?.afterSequence ?? 0);
                bounded = input?.bounded;
                return sink.stream(input);
              },
            },
            {
              locks,
              projections: {
                getThreadRecords: (...args) =>
                  projections.getThreadRecords(...args).pipe(
                    Effect.tap(() => {
                      handled++;
                      if (handled === 1)
                        return Deferred.succeed(stalled, undefined).pipe(
                          Effect.andThen(Deferred.await(release)),
                        );
                      return Deferred.succeed(caughtUp, undefined);
                    }),
                  ),
              },
              dispatch: () => Effect.die("The fixture has no queued steers"),
            },
          ).pipe(
            Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
            Effect.forkScoped,
          );
          const now = yield* DateTime.now;
          const event = (id: string, status: "running" | "pending") => ({
            id: EventId.make(id),
            type: "provider-turn.updated" as const,
            threadId,
            occurredAt: now,
            payload: { ...turn, status },
          });
          const [first] = yield* sink.write({ events: [event("event:before-stall", "running")] });
          yield* Deferred.await(stalled);
          assert.isTrue(bounded, "The stalled reactor must use the live event budget");
          const burst = yield* sink.write({
            events: Array.from({ length: LIVE_STREAM_MAX_ITEMS + 1 }, (_, index) =>
              event(`event:burst:${index}`, "pending"),
            ),
          });
          assert.lengthOf(burst, LIVE_STREAM_MAX_ITEMS + 1);
          yield* Deferred.await(overflow);
          yield* sink.write({ events: [event("event:catch-up", "running")] });
          yield* Deferred.succeed(release, undefined);
          yield* TestClock.adjust("1 second");
          yield* Deferred.await(caughtUp);
          assert.deepEqual(cursors, [initialCursor, first?.sequence]);
          assert.equal(handled, 2);
        }).pipe(Effect.provide(layer));
      }),
    ),
);
