import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

/**
 * Concurrent calls with one key share the first caller's result, failure or defect included. A
 * call made after that flight ended starts a new one. When the running caller is interrupted, its
 * waiters elect a new one rather than end with an interruption that was not theirs.
 */
export const makeKeyedSingleFlight = <A, E>() => {
  const flights = new Map<string, Deferred.Deferred<A, E>>();
  const share = <R>(key: string, work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const running = flights.get(key);
      if (running !== undefined)
        return Deferred.await(running).pipe(
          Effect.catchCauseIf(Cause.hasInterruptsOnly, () => share(key, work)),
        );
      const flight = Deferred.makeUnsafe<A, E>();
      flights.set(key, flight);
      return work.pipe(
        Effect.onExit((exit) => {
          if (flights.get(key) === flight) flights.delete(key);
          return Deferred.done(flight, exit);
        }),
      );
    });
  return share;
};
