import type { CommandId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

interface Slot {
  attempts: number;
  creating: number;
  ended: number;
  idle: Deferred.Deferred<void>;
}

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
  // Per command while any attempt runs: attempts in flight, those past the CLI check that may still
  // create its thread, and how many of those have ended.
  const slots = new Map<CommandId, Slot>();
  const slotOf = (commandId: CommandId) => {
    const existing = slots.get(commandId);
    if (existing !== undefined) return existing;
    const slot: Slot = { attempts: 0, creating: 0, ended: 0, idle: Deferred.makeUnsafe<void>() };
    slots.set(commandId, slot);
    return slot;
  };
  /** Runs a CLI check; once it passes, this attempt counts until it ends. */
  const passCli = <E, R>(commandId: CommandId, check: Effect.Effect<void, E, R>) =>
    Effect.tap(check, () =>
      Effect.map(Effect.serviceOption(LaunchAttempt), (attempt) => {
        const slot = slots.get(commandId);
        if (Option.isNone(attempt) || attempt.value.passed || slot === undefined) return;
        attempt.value.passed = true;
        slot.creating += 1;
      }),
    );
  const settleCliRaces =
    <I extends { readonly commandId: CommandId }, A, E, R>(
      launch: (input: I) => Effect.Effect<A, E, R>,
    ) =>
    (input: I): Effect.Effect<A, E, R> =>
      Effect.suspend(() => {
        const id = input.commandId;
        const slot = slotOf(id);
        slot.attempts += 1;
        const seen = slot.ended;
        const attempt = { passed: false };
        const end = Effect.suspend(() => {
          slot.attempts -= 1;
          if (slot.attempts === 0 && slots.get(id) === slot) slots.delete(id);
          if (!attempt.passed) return Effect.void;
          slot.creating -= 1;
          slot.ended += 1;
          if (slot.creating > 0) return Effect.void;
          const idle = slot.idle;
          slot.idle = Deferred.makeUnsafe<void>();
          return Deferred.succeed(idle, undefined);
        });
        return launch(input).pipe(
          Effect.provideService(LaunchAttempt, attempt),
          Effect.ensuring(end),
          // Another attempt of this command may create, or may have created, its thread: wait it
          // out, then try again as a counted attempt, which replays a created thread's receipt.
          Effect.catchIf(
            (error) => isCliMissing(error) && (slot.creating > 0 || slot.ended !== seen),
            () =>
              (slot.creating > 0 ? Deferred.await(slot.idle) : Effect.void).pipe(
                Effect.andThen(settleCliRaces(launch)(input)),
              ),
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
