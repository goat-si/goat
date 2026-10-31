import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

export const watchClaimChanges = Effect.fn("ComputerUseLeaseClaimChanges.watch")(function* (
  changes: Stream.Stream<number>,
  wake: Queue.Queue<void>,
) {
  const ready = yield* Deferred.make<void>();
  let first = true;
  yield* changes.pipe(
    Stream.runForEach(() => {
      if (first) {
        first = false;
        return Deferred.succeed(ready, undefined).pipe(Effect.asVoid);
      }
      return Queue.offer(wake, undefined).pipe(Effect.asVoid);
    }),
    Effect.forkScoped,
  );
  yield* Deferred.await(ready);
});
