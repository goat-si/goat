import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export function makeCodexContextRestores(scope: Scope.Scope) {
  const byThread = new Map<string, Set<Deferred.Deferred<void>>>();
  const fork = Effect.fnUntraced(function* (threadId: string, restore: Effect.Effect<void>) {
    const done = yield* Deferred.make<void>();
    const pending = byThread.get(threadId) ?? new Set();
    pending.add(done);
    byThread.set(threadId, pending);
    // Announce the restore before publishing turn completion, but don't block the
    // notification reader: it has to deliver the injection response to this fiber.
    yield* restore.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          pending.delete(done);
          if (pending.size === 0) byThread.delete(threadId);
        }).pipe(Effect.andThen(Deferred.succeed(done, undefined))),
      ),
      Effect.forkIn(scope, { startImmediately: true }),
    );
  });
  const wait = Effect.fnUntraced(function* (threadId: string) {
    let done = byThread.get(threadId)?.values().next().value;
    while (done !== undefined) {
      yield* Deferred.await(done);
      done = byThread.get(threadId)?.values().next().value;
    }
  });
  return { fork, wait };
}
