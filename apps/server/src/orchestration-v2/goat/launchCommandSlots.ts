import type { CommandId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

/** The launch attempt a CLI check belongs to. */
class LaunchAttempt extends Context.Service<LaunchAttempt, { passed: boolean }>()(
  "goat/orchestration-v2/goat/launchCommandSlots/LaunchAttempt",
) {}

/**
 * Per-command launch bookkeeping: one preparation per command, and attempts of one command that
 * race. An attempt refused for a missing CLI while another attempt of its command has passed its
 * check waits for that one to end and tries again, so it never reports a thread that attempt
 * created as never created.
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
  // Per command, the attempts that passed the CLI check and may still create its thread.
  const creating = new Map<CommandId, { count: number; readonly idle: Deferred.Deferred<void> }>();
  /** Runs a CLI check; once it passes, this attempt counts until it ends. */
  const passCli = <E, R>(commandId: CommandId, check: Effect.Effect<void, E, R>) =>
    Effect.tap(check, () =>
      Effect.map(Effect.serviceOption(LaunchAttempt), (attempt) => {
        if (Option.isNone(attempt) || attempt.value.passed) return;
        attempt.value.passed = true;
        const entry = creating.get(commandId) ?? { count: 0, idle: Deferred.makeUnsafe<void>() };
        entry.count += 1;
        creating.set(commandId, entry);
      }),
    );
  const settleCliRaces =
    <I extends { readonly commandId: CommandId }, A, E, R>(
      launch: (input: I) => Effect.Effect<A, E, R>,
    ) =>
    (input: I): Effect.Effect<A, E, R> =>
      Effect.suspend(() => {
        const id = input.commandId;
        const attempt = { passed: false };
        const end = Effect.suspend(() => {
          const entry = creating.get(id);
          if (!attempt.passed || entry === undefined) return Effect.void;
          entry.count -= 1;
          if (entry.count > 0) return Effect.void;
          creating.delete(id);
          return Deferred.succeed(entry.idle, undefined);
        });
        return launch(input).pipe(
          Effect.provideService(LaunchAttempt, attempt),
          Effect.ensuring(end),
          Effect.catchIf(
            (error) => isCliMissing(error) && creating.has(id),
            (refused) => {
              const entry = creating.get(id);
              // Wait out every attempt that may create the thread, then try again as a counted
              // attempt: a created thread replays from its receipt, otherwise this refuses anew.
              return entry === undefined
                ? Effect.fail(refused)
                : Deferred.await(entry.idle).pipe(Effect.andThen(settleCliRaces(launch)(input)));
            },
          ),
        );
      });
  return { reservePreparation, releasePreparation, passCli, settleCliRaces };
});

const isCliMissing = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "ProviderCliMissingError";
