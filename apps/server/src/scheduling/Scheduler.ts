import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as AutomationHold from "../automationHold.ts";
import { forkParked } from "../serverActivation.ts";

export interface SchedulerSourceOptions {
  /**
   * Sources skip their runs while automation is held (see AutomationHold) unless they only read
   * or keep local bookkeeping. A held run is skipped, not queued: the next tick after release
   * finds the same due work.
   */
  readonly whileAutomationHeld?: "skip" | "run";
}

export class Scheduler extends Context.Service<
  Scheduler,
  {
    readonly register: <E, R>(
      name: string,
      runDueWork: Effect.Effect<void, E, R>,
      options?: SchedulerSourceOptions,
    ) => Effect.Effect<void, never, R | Scope.Scope>;
  }
>()("goat/scheduling/Scheduler") {}

const make = Effect.gen(function* () {
  const sources = yield* Ref.make(new Map<symbol, Effect.Effect<void>>());
  const register: Scheduler["Service"]["register"] = Effect.fn("Scheduler.register")(function* <
    E,
    R,
  >(name: string, runDueWork: Effect.Effect<void, E, R>, options?: SchedulerSourceOptions) {
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<R>();
    const hold = yield* AutomationHold.AutomationHold;
    const permit = yield* Semaphore.make(1);
    const gated =
      options?.whileAutomationHeld === "run"
        ? runDueWork
        : hold.current.pipe(Effect.flatMap((held) => (held === null ? runDueWork : Effect.void)));
    const run = gated.pipe(
      Effect.provideContext(context),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("Scheduler source failed", { source: name, cause }),
      ),
      permit.withPermitsIfAvailable(1),
      Effect.forkIn(scope),
      Effect.asVoid,
    );
    const id = Symbol(name);
    yield* Effect.acquireRelease(
      Ref.update(sources, (current) => new Map(current).set(id, run)),
      () =>
        Ref.update(sources, (current) => {
          const next = new Map(current);
          next.delete(id);
          return next;
        }),
    );
    // Due work waits for startup recovery, which would cancel runs it started.
    yield* forkParked(run);
  });
  const tick = Ref.get(sources).pipe(
    Effect.flatMap((current) => Effect.forEach(current.values(), (run) => run, { discard: true })),
  );
  yield* forkParked(Effect.sleep("5 seconds").pipe(Effect.andThen(tick), Effect.forever));
  return Scheduler.of({ register });
});

export const layer = Layer.effect(Scheduler, make);
