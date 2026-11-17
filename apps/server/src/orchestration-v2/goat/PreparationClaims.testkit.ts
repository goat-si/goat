import type { CommandId, RunId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";

import type * as ThreadManagement from "../ThreadManagementService.ts";
import { PreparationClaims, layer as layerClaims } from "./PreparationClaims.ts";

export interface ClaimOutcome {
  readonly runId: RunId;
  /** Whether the preparation ran under the claim. */
  readonly ran: boolean;
}

/** The real claims, reporting what preparations did with them. */
export const makeClaimProbe = Effect.gen(function* () {
  const attempts = yield* Queue.unbounded<RunId>();
  const outcomes = yield* Queue.unbounded<ClaimOutcome>();
  // When set, the next preparation to ask for a claim waits here before it joins the line.
  const lineGate = yield* Ref.make<Deferred.Deferred<void> | undefined>(undefined);
  const atLine = yield* Queue.unbounded<void>();
  return {
    layer: Layer.effect(
      PreparationClaims,
      Effect.gen(function* () {
        const real = yield* PreparationClaims;
        return PreparationClaims.of({
          ...real,
          whileClaimed: (runId, body, queued) =>
            Effect.gen(function* () {
              const ran = yield* Ref.make(false);
              yield* Queue.offer(attempts, runId);
              const gate = yield* Ref.getAndSet(lineGate, undefined);
              if (gate !== undefined) {
                yield* Queue.offer(atLine, undefined);
                yield* Deferred.await(gate);
              }
              yield* real
                .whileClaimed(runId, Effect.andThen(Ref.set(ran, true), body), queued)
                .pipe(
                  Effect.ensuring(
                    Effect.flatMap(Ref.get(ran), (value) =>
                      Queue.offer(outcomes, { runId, ran: value }),
                    ),
                  ),
                );
            }),
        });
      }),
    ).pipe(Layer.provide(layerClaims)),
    /** A preparation has asked for the run's claim (it may be waiting for it). */
    attempted: Queue.take(attempts),
    /** A preparation's claim ended, and whether it ran. */
    outcome: Queue.take(outcomes),
    /**
     * Holds the next preparation that asks for a claim before it joins the line, so its caller
     * holds only its pending mark. The first effect returned waits until it is held; the second
     * lets it go on.
     */
    holdNextAtLine: Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      yield* Ref.set(lineGate, gate);
      return {
        held: Queue.take(atLine),
        release: Deferred.succeed(gate, undefined).pipe(Effect.asVoid),
      };
    }),
  };
});

type Threads = ThreadManagement.ThreadManagementService["Service"];

/**
 * Holds a launch right after its first read of one run, which comes after it reserved its command
 * and before it forks the preparation, and reports the launch's later reads of that run and the
 * releases it dispatches.
 */
export const makeLaunchHold = Effect.gen(function* () {
  const armed = yield* Ref.make(false);
  const held = yield* Deferred.make<void>();
  const resume = yield* Deferred.make<void>();
  const readAgain = yield* Deferred.make<void>();
  const releases = yield* Ref.make<ReadonlyArray<CommandId>>([]);
  const released = yield* Deferred.make<void>();
  let reads = 0;
  const wrap = (threads: Threads): Threads => ({
    ...threads,
    getThreadRecords: (threadId, fields, filter) =>
      threads.getThreadRecords(threadId, fields, filter).pipe(
        Effect.tap(() =>
          Effect.gen(function* () {
            if (filter?.runIds === undefined || !(yield* Ref.get(armed))) return;
            reads += 1;
            if (reads > 1) return yield* Deferred.succeed(readAgain, undefined);
            yield* Deferred.succeed(held, undefined);
            yield* Deferred.await(resume);
          }),
        ),
      ),
    dispatch: (command) =>
      (command.type === "prepared-run.release"
        ? Ref.update(releases, (current) => [...current, command.commandId]).pipe(
            Effect.andThen(Deferred.succeed(released, undefined)),
          )
        : Effect.void
      ).pipe(Effect.andThen(threads.dispatch(command))),
  });
  return {
    wrap,
    arm: Ref.set(armed, true),
    held: Deferred.await(held),
    resume: Deferred.succeed(resume, undefined),
    /** "read again" once the launch read the run a second time, "released" once it released it. */
    next: Effect.raceFirst(
      Deferred.await(readAgain).pipe(Effect.as("read again" as const)),
      Deferred.await(released).pipe(Effect.as("released" as const)),
    ),
    releases: Ref.get(releases),
  };
});
