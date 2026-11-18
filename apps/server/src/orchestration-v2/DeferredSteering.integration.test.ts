import { assert, it } from "@effect/vitest";
import { CommandId, EventId, MessageId, RunAttemptId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
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
