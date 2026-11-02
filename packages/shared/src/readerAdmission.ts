import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";
import { ReaderAdmissionOverloadError } from "./readerAdmissionOverload.ts";

export class ReaderAdmissionClosedError extends Error {
  constructor() {
    super("Database client closed");
    this.name = "ReaderAdmissionClosedError";
  }
}

export const admissionSqlError = (
  cause: ReaderAdmissionOverloadError | ReaderAdmissionClosedError,
) =>
  new SqlError({
    reason: classifySqliteError(cause, {
      message:
        cause instanceof ReaderAdmissionClosedError
          ? "Database client closed"
          : "Database reader overloaded",
      operation: "acquire",
    }),
  });

const FailFastReaderAdmission = Context.Reference<boolean>("@goat/shared/FailFastReaderAdmission", {
  defaultValue: () => false,
});
export const failFastReaderAdmission = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, FailFastReaderAdmission, true);

export const readerAdmissionTimeout = (input: Duration.Input = "30 seconds") => {
  const duration = Duration.fromInputUnsafe(input);
  const nan =
    typeof input === "number"
      ? Number.isNaN(input)
      : typeof input === "object" &&
        input !== null &&
        Object.values(input).some((value) => typeof value === "number" && Number.isNaN(value));
  if (nan || !Duration.isFinite(duration) || Duration.toMillis(duration) < 0)
    throw new Error("readerAdmissionTimeout must be finite and nonnegative");
  return duration;
};

type Waiter = {
  state: "queued" | "granted" | "expired" | "cancelled" | "closed";
  readonly deferred: Deferred.Deferred<
    void,
    ReaderAdmissionOverloadError | ReaderAdmissionClosedError
  >;
  readonly deadline: bigint | null;
  readonly clock: Clock.Clock;
  timer?: Fiber.Fiber<void>;
};

export const makeReaderAdmission = Effect.fn("ReaderAdmission.make")(function* (options: {
  readonly limit: number;
  readonly timeout: Duration.Duration | null;
  readonly honorFailFast: boolean;
}) {
  const scope = yield* Effect.scope;
  const context = yield* Effect.context<never>();
  let held = 0;
  let closed = false;
  const queue: Waiter[] = [];
  const stopTimer = (waiter: Waiter) => {
    if (waiter.timer !== undefined) Effect.runForkWith(context)(Fiber.interrupt(waiter.timer));
  };
  const remove = (waiter: Waiter) => {
    const index = queue.indexOf(waiter);
    if (index >= 0) queue.splice(index, 1);
  };
  const expire = (waiter: Waiter) => {
    if (waiter.state !== "queued") return;
    remove(waiter);
    waiter.state = "expired";
    // @effect-diagnostics-next-line globalErrorInEffectFailure:off -- Preserve the existing overload error identity.
    Deferred.doneUnsafe(waiter.deferred, Effect.fail(new ReaderAdmissionOverloadError()));
  };
  const pump = (arrival?: Waiter) => {
    while (queue.length > 0) {
      const waiter = queue[0];
      if (waiter === undefined) break;
      if (
        waiter !== arrival &&
        waiter.deadline !== null &&
        waiter.clock.monotonicTimeNanosUnsafe() >= waiter.deadline
      ) {
        expire(waiter);
        stopTimer(waiter);
        continue;
      }
      if (held >= options.limit) break;
      queue.shift();
      waiter.state = "granted";
      held++;
      stopTimer(waiter);
      Deferred.doneUnsafe(waiter.deferred, Effect.void);
    }
    if (
      arrival?.state === "queued" &&
      arrival.deadline !== null &&
      arrival.clock.monotonicTimeNanosUnsafe() >= arrival.deadline
    )
      expire(arrival);
  };
  const release = Effect.sync(() => {
    held--;
    pump();
  });
  yield* Scope.addFinalizer(
    scope,
    Effect.sync(() => {
      closed = true;
      for (const waiter of queue.splice(0)) {
        waiter.state = "closed";
        stopTimer(waiter);
        // @effect-diagnostics-next-line globalErrorInEffectFailure:off -- The gate exposes a distinct closure error.
        Deferred.doneUnsafe(waiter.deferred, Effect.fail(new ReaderAdmissionClosedError()));
      }
    }),
  );
  const acquire = (restore?: typeof Effect.interruptible) =>
    Effect.uninterruptibleMask((restoreCaller) =>
      Effect.withFiber((fiber) =>
        Effect.gen(function* () {
          // @effect-diagnostics-next-line globalErrorInEffectFailure:off -- The gate exposes a distinct closure error.
          if (closed) return yield* Effect.fail(new ReaderAdmissionClosedError());
          if (
            options.honorFailFast &&
            fiber.getRef(FailFastReaderAdmission) &&
            (held >= options.limit || queue.length > 0)
          )
            // @effect-diagnostics-next-line globalErrorInEffectFailure:off -- Preserve the existing overload error identity.
            return yield* Effect.fail(new ReaderAdmissionOverloadError());
          const clock = fiber.getRef(Clock.Clock);
          const deadline =
            options.timeout === null
              ? null
              : clock.monotonicTimeNanosUnsafe() + Duration.toNanosUnsafe(options.timeout);
          const waiter: Waiter = {
            state: "queued",
            deferred: Deferred.makeUnsafe(),
            deadline,
            clock,
          };
          queue.push(waiter);
          pump(waiter);
          if (waiter.state === "queued" && deadline !== null) {
            const timer = Effect.gen(function* () {
              const remaining = deadline - clock.monotonicTimeNanosUnsafe();
              if (remaining > 0n) yield* Effect.sleep(Duration.nanos(remaining));
              yield* Effect.sync(() => expire(waiter));
            });
            waiter.timer = yield* Effect.forkIn(timer, scope, {
              startImmediately: true,
              uninterruptible: false,
            });
            if (waiter.state !== "queued") stopTimer(waiter);
          }
          return yield* Effect.onExit(
            (restore ?? restoreCaller)(Deferred.await(waiter.deferred)),
            (exit) =>
              Effect.sync(() => {
                if (Exit.isSuccess(exit)) return;
                if (waiter.state === "granted") {
                  held--;
                  pump();
                } else if (waiter.state === "queued") {
                  remove(waiter);
                  waiter.state = "cancelled";
                  stopTimer(waiter);
                  pump();
                }
              }),
          );
        }),
      ),
    );
  return { acquire, release };
});
