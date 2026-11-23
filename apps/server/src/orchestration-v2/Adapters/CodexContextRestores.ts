import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";

const MAX_RESTORES = 256;

class CodexContextRestoreError extends Data.TaggedError("CodexContextRestoreError")<{
  readonly detail: string;
}> {
  override get message() {
    return this.detail;
  }
}

type Restore = {
  readonly done: Deferred.Deferred<boolean>;
  readonly run: Effect.Effect<boolean>;
};

export function makeCodexContextRestores(scope: Scope.Scope) {
  const byThread = new Map<string, Set<Restore>>();
  const compactions = new Map<string, string>();
  let count = 0;
  let overflow = false;
  const retryPermit = Semaphore.makeUnsafe(1);
  const remove = (threadId: string, restore: Restore) => {
    const pending = byThread.get(threadId);
    if (pending?.delete(restore)) count--;
    if (pending?.size === 0) byThread.delete(threadId);
  };
  const mark = (threadId: string, compactionId: string) => {
    if (!compactions.has(threadId) && compactions.size >= MAX_RESTORES) overflow = true;
    else compactions.set(threadId, compactionId);
  };
  const take = (threadId: string) => {
    const id = compactions.get(threadId);
    compactions.delete(threadId);
    return id;
  };
  const fork = Effect.fnUntraced(function* <E>(threadId: string, effect: Effect.Effect<void, E>) {
    if (count >= MAX_RESTORES) {
      overflow = true;
      return;
    }
    const done = yield* Deferred.make<boolean>();
    const run = effect.pipe(Effect.matchCause({ onFailure: () => false, onSuccess: () => true }));
    const restore = { done, run };
    const pending = byThread.get(threadId) ?? new Set<Restore>();
    pending.add(restore);
    count++;
    byThread.set(threadId, pending);
    // The notification reader must remain free to deliver the injection response.
    yield* run.pipe(
      Effect.tap((ok) =>
        Effect.sync(() => {
          if (ok) remove(threadId, restore);
        }),
      ),
      Effect.flatMap((ok) => Deferred.succeed(done, ok)),
      Effect.forkIn(scope, { startImmediately: true }),
    );
  });
  const wait = Effect.fnUntraced(function* (threadId: string) {
    if (overflow)
      return yield* new CodexContextRestoreError({
        detail:
          "Codex context restoration capacity exceeded; restart the provider session before retrying.",
      });
    let pending = byThread.get(threadId)?.values().next().value;
    while (pending !== undefined) {
      const restore = pending;
      if (!(yield* Deferred.await(restore.done))) {
        yield* Effect.gen(function* () {
          if (!byThread.get(threadId)?.has(restore)) return;
          const ok = yield* restore.run;
          if (!ok)
            return yield* new CodexContextRestoreError({
              detail: "Codex could not restore context after compaction. Retry the turn.",
            });
          remove(threadId, restore);
        }).pipe(retryPermit.withPermits(1));
      }
      pending = byThread.get(threadId)?.values().next().value;
    }
    if (overflow)
      return yield* new CodexContextRestoreError({
        detail:
          "Codex context restoration capacity exceeded; restart the provider session before retrying.",
      });
  });
  return { fork, wait, mark, take };
}
