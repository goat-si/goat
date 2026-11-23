import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import type * as CodexSchema from "effect-codex-app-server/schema";

const MAX_RESTORES = 256;
const overflowKey = Symbol("codex-context-restore-overflow");
type Context = Record<string, CodexSchema.V2TurnStartParams__AdditionalContextEntry> & {
  [overflowKey]?: object;
};

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
  readonly marker: object | undefined;
  fiber?: Fiber.Fiber<boolean>;
};

export function makeCodexContextRestores(
  scope: Scope.Scope,
  contexts: Ref.Ref<Map<string, Context>>,
) {
  const byThread = new Map<string, Set<Restore>>();
  const compactions = new Map<string, string>();
  let count = 0;
  const retryPermit = Semaphore.makeUnsafe(1);
  const remove = (threadId: string, restore: Restore) => {
    const pending = byThread.get(threadId);
    if (pending?.delete(restore)) count--;
    if (pending?.size === 0) byThread.delete(threadId);
  };
  const overflow = (threadId: string) =>
    Ref.update(contexts, (current) => {
      const context = current.get(threadId);
      // No cached context means there is nothing for the dropped restore to inject.
      if (!context) return current;
      return new Map(current).set(threadId, { ...context, [overflowKey]: {} });
    });
  const resetOverflow = (threadId: string, marker: object | undefined) =>
    Ref.update(contexts, (current) => {
      const context = current.get(threadId);
      if (!marker || context?.[overflowKey] !== marker) return current;
      const next = { ...context };
      delete next[overflowKey];
      return new Map(current).set(threadId, next);
    });
  const mark = Effect.fnUntraced(function* (threadId: string, compactionId: string) {
    if (!compactions.has(threadId) && compactions.size >= MAX_RESTORES) yield* overflow(threadId);
    else compactions.set(threadId, compactionId);
  });
  const take = (threadId: string) => {
    const id = compactions.get(threadId);
    compactions.delete(threadId);
    return id;
  };
  const clear = Effect.fnUntraced(function* (threadId: string) {
    compactions.delete(threadId);
    const pending = byThread.get(threadId);
    if (pending) {
      for (const restore of pending) {
        remove(threadId, restore);
        if (restore.fiber) yield* Fiber.interrupt(restore.fiber);
        yield* Deferred.succeed(restore.done, true);
      }
    }
    const marker = (yield* Ref.get(contexts)).get(threadId)?.[overflowKey];
    yield* resetOverflow(threadId, marker);
  });
  const fork = Effect.fnUntraced(function* <E>(threadId: string, effect: Effect.Effect<void, E>) {
    if (count >= MAX_RESTORES) {
      yield* overflow(threadId);
      return;
    }
    const marker = (yield* Ref.get(contexts)).get(threadId)?.[overflowKey];
    const done = yield* Deferred.make<boolean>();
    const run = effect.pipe(Effect.matchCause({ onFailure: () => false, onSuccess: () => true }));
    const restore: Restore = { done, run, marker };
    const pending = byThread.get(threadId) ?? new Set<Restore>();
    pending.add(restore);
    count++;
    byThread.set(threadId, pending);
    // The notification reader must remain free to deliver the injection response.
    restore.fiber = yield* run.pipe(
      Effect.tap((ok) =>
        ok
          ? resetOverflow(threadId, marker).pipe(
              Effect.andThen(Effect.sync(() => remove(threadId, restore))),
            )
          : Effect.void,
      ),
      Effect.flatMap((ok) => Deferred.succeed(done, ok)),
      Effect.forkIn(scope, { startImmediately: true }),
    );
  });
  const wait = Effect.fnUntraced(function* (threadId: string) {
    let pending = byThread.get(threadId)?.values().next().value;
    while (pending !== undefined) {
      const restore = pending;
      if (!(yield* Deferred.await(restore.done))) {
        yield* Effect.gen(function* () {
          if (!byThread.get(threadId)?.has(restore)) return;
          const retry = yield* restore.run.pipe(Effect.forkIn(scope, { startImmediately: true }));
          restore.fiber = retry;
          if (!byThread.get(threadId)?.has(restore)) {
            yield* Fiber.interrupt(retry);
            return;
          }
          const result = yield* Fiber.join(retry).pipe(
            Effect.onInterrupt(() => Fiber.interrupt(retry)),
            Effect.exit,
          );
          if (!byThread.get(threadId)?.has(restore)) return;
          if (!Exit.isSuccess(result) || !result.value)
            return yield* new CodexContextRestoreError({
              detail: "Codex could not restore context after compaction. Retry the turn.",
            });
          yield* resetOverflow(threadId, restore.marker);
          remove(threadId, restore);
        }).pipe(retryPermit.withPermits(1));
      }
      pending = byThread.get(threadId)?.values().next().value;
    }
    if ((yield* Ref.get(contexts)).get(threadId)?.[overflowKey])
      return yield* new CodexContextRestoreError({
        detail:
          "Codex context restoration capacity exceeded; restart the provider session before retrying.",
      });
  });
  return { fork, wait, mark, take, clear };
}
