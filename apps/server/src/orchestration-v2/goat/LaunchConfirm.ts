/**
 * A launch step a server-side launcher can still refuse. A fleet goal acts for an owner whose
 * authority can be withdrawn while its launch runs, so ThreadLaunchService asks right before it
 * hands the thread's creation, and then its first message, to the orchestrator. Preparation and
 * cleanup never ask: they finish what was already handed over.
 */
import * as Effect from "effect/Effect";

/** Answers whether the launcher may still take the next step; false refuses it. */
export type LaunchConfirm = Effect.Effect<boolean>;

export const confirmLaunchStep = <E>(
  confirm: LaunchConfirm | undefined,
  refuse: (cause: string) => E,
): Effect.Effect<void, E> =>
  confirm === undefined
    ? Effect.void
    : Effect.flatMap(confirm, (allowed) =>
        allowed ? Effect.void : Effect.fail(refuse("The launcher may no longer start this work.")),
      );
