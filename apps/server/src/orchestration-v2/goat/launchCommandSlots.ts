import type { CommandId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

/**
 * Per-command launch bookkeeping: one preparation per command, and attempts of one command that
 * race. An attempt refused for a missing CLI while another attempt of its command runs waits for
 * it and tries once more, so it never reports a thread the other attempt created as never created.
 */
export const makeLaunchCommandSlots = Effect.gen(function* () {
  const scheduled = yield* Ref.make<ReadonlySet<CommandId>>(new Set());
  const reservePreparation = (commandId: CommandId) =>
    Ref.modify(scheduled, (current) => {
      if (current.has(commandId)) return [false, current] as const;
      const next = new Set(current);
      next.add(commandId);
      return [true, next] as const;
    });
  const releasePreparation = (commandId: CommandId) =>
    Ref.update(scheduled, (current) => {
      const next = new Set(current);
      next.delete(commandId);
      return next;
    });
  // Entries live only while an attempt for that command runs.
  const attempts = new Map<CommandId, Set<Deferred.Deferred<void>>>();
  const settleCliRaces =
    <I extends { readonly commandId: CommandId }, A, E, R>(
      launch: (input: I) => Effect.Effect<A, E, R>,
    ) =>
    (input: I): Effect.Effect<A, E, R> =>
      Effect.suspend(() => {
        const id = input.commandId;
        const racing = attempts.get(id) ?? new Set<Deferred.Deferred<void>>();
        attempts.set(id, racing);
        const mine = Deferred.makeUnsafe<void>();
        racing.add(mine);
        // Leaving first means two refused attempts never wait on each other.
        const leave = Effect.sync(() => {
          racing.delete(mine);
          if (racing.size === 0 && attempts.get(id) === racing) attempts.delete(id);
        }).pipe(Effect.andThen(Deferred.succeed(mine, undefined)));
        return launch(input).pipe(
          Effect.catchIf(
            (error) => isCliMissing(error) && racing.size > 1,
            () =>
              leave.pipe(
                Effect.andThen(
                  Effect.suspend(() =>
                    Effect.forEach([...racing], Deferred.await, { discard: true }),
                  ),
                ),
                // The other attempt may have created the thread: this replays its receipt.
                Effect.andThen(launch(input)),
              ),
          ),
          Effect.ensuring(leave),
        );
      });
  return { reservePreparation, releasePreparation, settleCliRaces };
});

const isCliMissing = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "ProviderCliMissingError";
