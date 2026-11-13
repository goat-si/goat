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
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
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
      // A fenced turn a run recorded is that run's own turn, left by a restart or a dropped
      // connection, not an unowned one.
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
  const reconcile = (threadId: ThreadId, holds: ReadonlyMap<ThreadId, ThreadHold>) =>
    orchestrator
      .getThreadRecords(threadId, ["runs"], { runStatuses: ["starting"] })
      .pipe(Effect.flatMap(({ runs }) => Effect.forEach(runs, (run) => update(run, holds))));
  const reconcileHeld = Effect.gen(function* () {
    const holds = yield* threadHolds(survivors);
    for (const threadId of holds.keys()) yield* reconcile(threadId, holds);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not record why held runs are waiting to start", { cause }),
    ),
  );
  /** A fence can change with no run event, as when a person stops the turn that held a run. */
  const reconcileThread = (threadId: ThreadId) =>
    threadHolds(survivors).pipe(
      Effect.flatMap((holds) => reconcile(threadId, holds)),
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not record why a thread's runs are waiting to start", {
          threadId,
          cause,
        }),
      ),
    );
  /**
   * Follows run events, then marks runs a hold already covered; returns once both are in place,
   * so no run can start waiting between the two unseen.
   */
  const start = Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    // A fence can change on its own, as when one of two held turns ends; changes in a burst
    // share one pass, and the writer never waits for it.
    let changed = false;
    let following = false;
    const catchUp: Effect.Effect<void> = Effect.suspend(() => {
      if (!changed) {
        following = false;
        return Effect.void;
      }
      changed = false;
      return reconcileHeld.pipe(Effect.andThen(catchUp));
    });
    yield* survivors.onFenceChange(
      Effect.suspend(() => {
        changed = true;
        if (following) return Effect.void;
        following = true;
        return catchUp.pipe(Effect.forkIn(scope), Effect.asVoid);
      }),
    );
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
  return { start, reconcileThread };
});

export class RunStartHolds extends Context.Service<
  RunStartHolds,
  { readonly reconcileThread: (threadId: ThreadId) => Effect.Effect<void> }
>()("goat/orchestration-v2/goat/RunStartHoldReactor/RunStartHolds") {}

export const layer = Layer.effect(
  RunStartHolds,
  Effect.gen(function* () {
    const reactor = yield* make;
    yield* forkParked(Effect.scoped(reactor.start.pipe(Effect.andThen(Effect.never))));
    return RunStartHolds.of({ reconcileThread: reactor.reconcileThread });
  }),
);
