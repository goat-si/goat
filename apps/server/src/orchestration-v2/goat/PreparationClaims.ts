import type { RunId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

/**
 * The runs something in this process is preparing or failing right now. A preparation and the
 * orphan check each hold a run's claim while they read and change it, so they exclude each other
 * and a run is never prepared twice. A run's claim is keyed by run, unlike the per-command
 * reservation in launchCommandSlots, because one run can be reached under several command ids.
 */
export class PreparationClaims extends Context.Service<
  PreparationClaims,
  {
    /** Runs `body` holding the run's claim; none, returning false, when another holder has it. */
    readonly whileClaimed: <E, R>(
      runId: RunId,
      body: Effect.Effect<void, E, R>,
    ) => Effect.Effect<boolean, E, R>;
  }
>()("goat/orchestration-v2/goat/PreparationClaims") {}

export const layer = Layer.effect(
  PreparationClaims,
  Effect.gen(function* () {
    const held = yield* Ref.make<ReadonlySet<RunId>>(new Set());
    const claim = (runId: RunId) =>
      Ref.modify(held, (current) => {
        if (current.has(runId)) return [false, current] as const;
        const next = new Set(current);
        next.add(runId);
        return [true, next] as const;
      });
    const release = (runId: RunId) =>
      Ref.update(held, (current) => {
        const next = new Set(current);
        next.delete(runId);
        return next;
      });
    return PreparationClaims.of({
      // Claim and release are installed in one uninterruptible step, so no interruption leaks one.
      whileClaimed: Effect.fn("PreparationClaims.whileClaimed")(function* <E, R>(
        runId: RunId,
        body: Effect.Effect<void, E, R>,
      ) {
        return yield* Effect.uninterruptibleMask((restore) =>
          claim(runId).pipe(
            Effect.flatMap((claimed) =>
              claimed
                ? restore(body).pipe(Effect.ensuring(release(runId)), Effect.as(true))
                : Effect.succeed(false),
            ),
          ),
        );
      }),
    });
  }),
);
