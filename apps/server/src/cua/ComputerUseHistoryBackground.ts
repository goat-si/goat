import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const pending = new Map<string, Deferred.Deferred<void>>();
export const refusalHistoryKey = (
  threadId: string,
  controlId: string,
  connectionId: string,
  callId: string,
) => JSON.stringify([threadId, controlId, connectionId, callId]);

export const scheduleHistory = Effect.fn("ComputerUseHistory.schedule")(function* <E, R>(
  key: string | undefined,
  write: Effect.Effect<void, E, R>,
) {
  const done = yield* Deferred.make<void>();
  if (key !== undefined) pending.set(key, done);
  yield* write.pipe(
    Effect.interruptible,
    Effect.timeoutOption("5 seconds"),
    Effect.flatMap((result) =>
      Option.isNone(result)
        ? Effect.logWarning("Computer use history write timed out")
        : Effect.void,
    ),
    Effect.catchCause((cause) => Effect.logWarning("Computer use history write failed", { cause })),
    Effect.ensuring(
      Effect.sync(() => {
        if (key !== undefined && pending.get(key) === done) pending.delete(key);
      }).pipe(Effect.andThen(Deferred.succeed(done, undefined)), Effect.asVoid),
    ),
    Effect.forkDetach,
  );
});

export const awaitHistory = (key: string) =>
  Effect.suspend(() => {
    const write = pending.get(key);
    return write === undefined ? Effect.void : Deferred.await(write);
  });
