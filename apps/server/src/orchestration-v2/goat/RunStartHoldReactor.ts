/**
 * Keeps `startHold` current on runs that Codex start admission holds: set when a run starts
 * waiting on a held thread, cleared once it starts or ends. Runs from before a restart get theirs
 * when the server activates.
 *
 * @module RunStartHoldReactor
 */
import {
  CommandId,
  type OrchestrationV2Run,
  type OrchestrationV2RunStartHold,
  type RunId,
  type ThreadId,
} from "@goat/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { nativeTurnOwnedByRun } from "../../provider/CodexHeldTurnStop.ts";
import * as CodexSurvivors from "../../provider/CodexSurvivors.ts";
import { forkParked } from "../../serverActivation.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import { withStartHold } from "./RunStartHold.ts";

interface ThreadHold {
  readonly hold: OrchestrationV2RunStartHold;
  /** Runs continuing these surviving runs start despite the hold. */
  readonly survivingRunIds: ReadonlySet<RunId>;
}

/** What holds each thread, from the same state the start guard reads. */
const threadHolds = Effect.fn("RunStartHoldReactor.threadHolds")(function* (
  survivors: CodexSurvivors.CodexSurvivors["Service"],
) {
  const holds = new Map<ThreadId, ThreadHold>();
  for (const binding of yield* survivors.list) {
    const surviving = new Set([
      ...(holds.get(binding.threadId)?.survivingRunIds ?? []),
      binding.sourceRunId,
    ]);
    holds.set(binding.threadId, {
      hold: holds.get(binding.threadId)?.hold ?? {
        reason: "restart_survivor",
        nativeTurnId: binding.nativeTurnId,
      },
      survivingRunIds: surviving,
    });
  }
  for (const threadId of yield* survivors.startBlockedThreads) {
    if (holds.has(threadId)) continue;
    const [obligation] = yield* survivors.getStopObligations(threadId);
    holds.set(threadId, {
      hold: {
        reason: "unowned_turn",
        ...(obligation === undefined ? {} : { nativeTurnId: obligation.block.nativeTurnId }),
      },
      survivingRunIds: new Set(),
    });
  }
  return holds;
});

const heldBy = (
  run: OrchestrationV2Run,
  holds: ReadonlyMap<ThreadId, ThreadHold>,
): OrchestrationV2RunStartHold | undefined => {
  const entry = holds.get(run.threadId);
  if (entry === undefined || run.status !== "starting") return undefined;
  if (
    run.restartContinuationOfRunId !== undefined &&
    entry.survivingRunIds.has(run.restartContinuationOfRunId)
  )
    return undefined;
  return entry.hold;
};

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const survivors = yield* CodexSurvivors.CodexSurvivors;
  const crypto = yield* Crypto.Crypto;
  const update = Effect.fn("RunStartHoldReactor.update")(
    function* (run: OrchestrationV2Run, holds: ReadonlyMap<ThreadId, ThreadHold>) {
      let hold = heldBy(run, holds);
      // A fenced turn a run recorded is that run's turn from before the restart, not an unowned one.
      if (hold?.reason === "unowned_turn" && hold.nativeTurnId !== undefined) {
        const { providerTurns } = yield* orchestrator.getThreadRecords(run.threadId, [
          "providerTurns",
        ]);
        if (nativeTurnOwnedByRun(providerTurns, hold.nativeTurnId))
          hold = { reason: "restart_survivor", nativeTurnId: hold.nativeTurnId };
      }
      if (withStartHold(run, hold) === null) return;
      const uuid = yield* crypto.randomUUIDv4();
      yield* orchestrator.dispatch({
        type: "run.start-hold.update",
        commandId: CommandId.make(`server:run-start-hold:${run.id}:${uuid}`),
        threadId: run.threadId,
        runId: run.id,
        startHold: hold ?? null,
      });
    },
    (effect, run) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not record why a run is waiting to start", {
            runId: run.id,
            cause,
          }),
        ),
      ),
  );
  /** Only a starting run, or one that still carries a hold, can change. */
  const observe = (run: OrchestrationV2Run) =>
    run.status !== "starting" && run.startHold === undefined
      ? Effect.void
      : threadHolds(survivors).pipe(Effect.flatMap((holds) => update(run, holds)));
  const reconcileHeld = Effect.gen(function* () {
    const holds = yield* threadHolds(survivors);
    for (const threadId of holds.keys()) {
      const { runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"], {
        runStatuses: ["starting"],
      });
      for (const run of runs) yield* update(run, holds);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not record why held runs are waiting to start", { cause }),
    ),
  );
  /**
   * Follows run events, then marks runs a hold already covered; returns once both are in place,
   * so no run can start waiting between the two unseen.
   */
  const start = Effect.gen(function* () {
    const cursor = yield* sink.latestSequence();
    const created = yield* Deferred.make<void>();
    const updated = yield* Deferred.make<void>();
    const follow = (eventType: "run.created" | "run.updated", ready: Deferred.Deferred<void>) =>
      sink.stream({
        afterSequence: cursor,
        eventType,
        onSubscribed: Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
      });
    yield* Stream.merge(follow("run.created", created), follow("run.updated", updated)).pipe(
      Stream.runForEach((stored) =>
        stored.event.type === "run.created" || stored.event.type === "run.updated"
          ? observe(stored.event.payload)
          : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Stopped recording why runs are waiting to start", { cause }),
      ),
      Effect.forkScoped,
    );
    yield* Deferred.await(created);
    yield* Deferred.await(updated);
    yield* reconcileHeld;
  });
  return { start };
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const reactor = yield* make;
    yield* forkParked(Effect.scoped(reactor.start.pipe(Effect.andThen(Effect.never))));
  }),
);
