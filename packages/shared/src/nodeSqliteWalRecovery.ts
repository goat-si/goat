import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import type { SqlError } from "effect/sql/SqlError";

// WAL recovery can bypass SQLite's busy handler and fails before changing data.
// Retry only SQLITE_BUSY_RECOVERY (261), never BUSY_SNAPSHOT or a whole transaction.
// Delay on the caller's Effect clock for at most 500 attempts of 10 ms.
const isWalRecovery = (error: SqlError) => {
  const cause = error.reason.cause;
  return Predicate.hasProperty(cause, "errcode") && cause.errcode === 261;
};

export const waitForWalRecovery = <A, R>(effect: Effect.Effect<A, SqlError, R>) =>
  Effect.catchIf(effect, isWalRecovery, () =>
    // Keep retry machinery off the successful first attempt. The first failure
    // already consumed one attempt, leaving 500 delayed attempts in total.
    Effect.delay(
      Effect.retry(effect, {
        times: 499,
        schedule: Schedule.spaced("10 millis"),
        while: isWalRecovery,
      }),
      "10 millis",
    ),
  );
