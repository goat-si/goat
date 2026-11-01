import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import type * as Fences from "./EffectExecutionFences.ts";
import type { OrchestrationEffectV2 } from "./EffectOutbox.ts";

class CurrentExecution extends Context.Reference<
  | {
      readonly token: OrchestrationEffectV2;
      readonly fences: Fences.EffectExecutionFences["Service"];
    }
  | undefined
>("goat/orchestration-v2/CurrentExecution", { defaultValue: () => undefined }) {}

const CLEANUP_GRACE_MS = 15_000;

const observeCleanup = Effect.fn("OwnedEffectDeadline.observeCleanup")(function* <A, E>(
  original: Fiber.Fiber<A, E>,
  current: NonNullable<Context.Service.Shape<typeof CurrentExecution>>,
) {
  // The join observer survives owner interruption and ends on retirement or after one warning.
  return yield* Fiber.await(original).pipe(
    Effect.timeoutOption(CLEANUP_GRACE_MS),
    Effect.flatMap((exit) =>
      Option.isNone(exit) ? current.fences.warnSlowCleanup(current.token) : Effect.void,
    ),
    Effect.forkDetach({ startImmediately: true }),
  );
});

export const runClaim = Effect.fn("OwnedEffectDeadline.runClaim")(function* <A, E, R>(input: {
  readonly claim: OrchestrationEffectV2;
  readonly fences: Fences.EffectExecutionFences["Service"];
  readonly execute: Effect.Effect<A, E, R>;
  readonly cancellation: Effect.Effect<unknown>;
}) {
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const admission = yield* input.fences.begin(input.claim);
      // Cancellation may retire admission before the executor is entered.
      if (Option.isNone(admission)) return "cancelled" as const;
      const token = admission.value;
      // Retirement follows scope closure, including an interrupted owner's join of the original.
      return yield* restore(
        Effect.scoped(
          Effect.gen(function* () {
            const original = yield* input.execute.pipe(
              Effect.provideService(CurrentExecution, { token, fences: input.fences }),
              Effect.forkScoped,
            );
            const outcome = yield* Effect.raceFirst(
              Fiber.await(original).pipe(
                Effect.map((exit) => ({ _tag: "executed" as const, exit })),
              ),
              input.cancellation.pipe(Effect.as({ _tag: "cancelled" as const })),
            );
            if (outcome._tag === "executed") {
              if (Exit.isFailure(outcome.exit)) return yield* Effect.failCause(outcome.exit.cause);
              return "executed" as const;
            }
            const observer = yield* observeCleanup(original, { token, fences: input.fences });
            yield* Fiber.interrupt(original);
            yield* Fiber.interrupt(observer);
            return "cancelled" as const;
          }),
        ),
      ).pipe(Effect.ensuring(input.fences.retireJoined(token)));
    }),
  );
});

// Only the title owner uses this budget; it excludes the completion command and agent lifetime.
export const generateTitle = Effect.fn("OwnedEffectDeadline.generateTitle")(function* <A, E, R>(
  execute: Effect.Effect<A, E, R>,
) {
  const current = yield* CurrentExecution;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const original = yield* execute.pipe(Effect.forkScoped);
      // Time the join waiter; interrupting it leaves the owned operation available to join below.
      const outcome = yield* Fiber.await(original).pipe(Effect.timeoutOption(120_000));
      if (Option.isSome(outcome)) {
        if (Exit.isFailure(outcome.value)) return yield* Effect.failCause(outcome.value.cause);
        return Option.some(outcome.value.value);
      }
      const observer = current === undefined ? undefined : yield* observeCleanup(original, current);
      yield* Fiber.interrupt(original);
      if (observer !== undefined) yield* Fiber.interrupt(observer);
      return Option.none<A>();
    }),
  );
});
