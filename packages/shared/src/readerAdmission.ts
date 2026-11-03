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

export type ReaderLaneName = "interactive" | "background";
/** Forked fibers inherit their parent's lane. */
const ReaderLane = Context.Reference<ReaderLaneName>("@goat/shared/ReaderLane", {
  defaultValue: () => "interactive",
});
/** Periodic sweeps yield reader admissions and reader slots to reads a person is waiting on. */
export const backgroundReads = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, ReaderLane, "background");
export const BACKGROUND_READER_ADMISSION_TIMEOUT = Duration.seconds(10);
/** A background waiter this old goes before newer interactive waiters, within its lane limit. */
export const READER_LANE_AGING_MS = 5_000;

export interface ReaderAdmissionToken {
  readonly lane: ReaderLaneName;
}

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
  readonly token: ReaderAdmissionToken;
  readonly deferred: Deferred.Deferred<
    ReaderAdmissionToken,
    ReaderAdmissionOverloadError | ReaderAdmissionClosedError
  >;
  readonly arrivedAt: bigint;
  readonly deadline: bigint | null;
  readonly clock: Clock.Clock;
  timer?: Fiber.Fiber<void>;
};

export const makeReaderAdmission = Effect.fn("ReaderAdmission.make")(function* (options: {
  readonly limit: number;
  readonly backgroundLimit: number;
  readonly timeout: Duration.Duration | null;
  readonly backgroundTimeout: Duration.Duration | null;
  readonly honorFailFast: boolean;
  readonly agingMs: number;
}) {
  const scope = yield* Effect.scope;
  const context = yield* Effect.context<never>();
  const agingNanos = BigInt(options.agingMs) * 1_000_000n;
  let held = 0;
  let backgroundHeld = 0;
  let closed = false;
  const queues: Record<ReaderLaneName, Array<Waiter>> = { interactive: [], background: [] };
  const stopTimer = (waiter: Waiter) => {
    if (waiter.timer !== undefined) Effect.runForkWith(context)(Fiber.interrupt(waiter.timer));
  };
  const remove = (waiter: Waiter) => {
    const queue = queues[waiter.token.lane];
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
  const due = (waiter: Waiter) =>
    waiter.deadline !== null && waiter.clock.monotonicTimeNanosUnsafe() >= waiter.deadline;
  const grantable = (lane: ReaderLaneName) =>
    held < options.limit && (lane === "interactive" || backgroundHeld < options.backgroundLimit);
  const next = () => {
    const interactive = queues.interactive[0];
    const background = queues.background[0];
    const aged =
      background !== undefined &&
      background.clock.monotonicTimeNanosUnsafe() - background.arrivedAt >= agingNanos;
    if (aged && grantable("background")) return background;
    if (interactive !== undefined && grantable("interactive")) return interactive;
    return background !== undefined && grantable("background") ? background : undefined;
  };
  // The arriving waiter may take free capacity before its own deadline is checked.
  const pump = (arrival?: Waiter) => {
    for (;;) {
      for (const queue of [queues.interactive, queues.background]) {
        for (
          let head = queue[0];
          head !== undefined && head !== arrival && due(head);
          head = queue[0]
        ) {
          expire(head);
          stopTimer(head);
        }
      }
      const waiter = next();
      if (waiter === undefined) break;
      queues[waiter.token.lane].shift();
      waiter.state = "granted";
      held++;
      if (waiter.token.lane === "background") backgroundHeld++;
      stopTimer(waiter);
      Deferred.doneUnsafe(waiter.deferred, Effect.succeed(waiter.token));
    }
    if (arrival?.state === "queued" && due(arrival)) expire(arrival);
  };
  const giveBack = (token: ReaderAdmissionToken) => {
    held--;
    if (token.lane === "background") backgroundHeld--;
    pump();
  };
  const release = (token: ReaderAdmissionToken) => Effect.sync(() => giveBack(token));
  yield* Scope.addFinalizer(
    scope,
    Effect.sync(() => {
      closed = true;
      for (const waiter of [...queues.interactive.splice(0), ...queues.background.splice(0)]) {
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
          const lane = fiber.getRef(ReaderLane);
          if (
            options.honorFailFast &&
            fiber.getRef(FailFastReaderAdmission) &&
            (queues[lane].length > 0 || !grantable(lane))
          )
            // @effect-diagnostics-next-line globalErrorInEffectFailure:off -- Preserve the existing overload error identity.
            return yield* Effect.fail(new ReaderAdmissionOverloadError());
          const clock = fiber.getRef(Clock.Clock);
          const arrivedAt = clock.monotonicTimeNanosUnsafe();
          const timeout = lane === "interactive" ? options.timeout : options.backgroundTimeout;
          const deadline = timeout === null ? null : arrivedAt + Duration.toNanosUnsafe(timeout);
          const waiter: Waiter = {
            state: "queued",
            token: { lane },
            deferred: Deferred.makeUnsafe(),
            arrivedAt,
            deadline,
            clock,
          };
          queues[lane].push(waiter);
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
                if (waiter.state === "granted") giveBack(waiter.token);
                else if (waiter.state === "queued") {
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

/** 64 reads may wait on the reader pool at once; background reads keep 16 of them free. */
export const makeClientReaderAdmission = (timeout: Duration.Input | undefined) =>
  makeReaderAdmission({
    limit: 64,
    backgroundLimit: 48,
    timeout: readerAdmissionTimeout(timeout),
    backgroundTimeout: BACKGROUND_READER_ADMISSION_TIMEOUT,
    honorFailFast: true,
    agingMs: READER_LANE_AGING_MS,
  });
