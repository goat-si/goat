import * as KeyedLock from "@goat/shared/KeyedLock";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";

interface ObservedBranch {
  readonly refName: string | null;
  readonly isRepo: boolean;
  readonly observation: number;
  readonly revision: number;
}

interface BranchListeners {
  readonly updates: PubSub.PubSub<ObservedBranch>;
  count: number;
  latest?: ObservedBranch;
}

export const makeBranchUpdates = Effect.gen(function* () {
  const locks = yield* KeyedLock.make<string>();
  const listenersByCwd = new Map<string, BranchListeners>();

  const subscribe = Effect.fn("VcsStatusBroadcaster.subscribeBranchUpdates")(function* (
    cwd: string,
  ) {
    const listeners = yield* Effect.acquireRelease(
      locks.withLock(
        cwd,
        Effect.gen(function* () {
          const existing = listenersByCwd.get(cwd);
          if (existing) {
            existing.count++;
            return existing;
          }
          const updates = yield* PubSub.sliding<ObservedBranch>(64);
          const listeners = { updates, count: 1 };
          listenersByCwd.set(cwd, listeners);
          return listeners;
        }),
      ),
      (listeners) =>
        locks.withLock(
          cwd,
          Effect.suspend(() => {
            if (--listeners.count) return Effect.void;
            listenersByCwd.delete(cwd);
            return PubSub.shutdown(listeners.updates);
          }),
        ),
    );
    return yield* PubSub.subscribe(listeners.updates);
  });

  const publish = Effect.fn("VcsStatusBroadcaster.publishBranch")(function* (
    cwd: string,
    { refName, isRepo }: Pick<ObservedBranch, "refName" | "isRepo">,
    observation: number,
  ) {
    return yield* locks.withLock(
      cwd,
      Effect.gen(function* () {
        const listeners = listenersByCwd.get(cwd);
        if (!listeners) return;
        const previous = listeners.latest;
        if (previous && previous.observation > observation) return;
        if (previous?.refName === refName && previous.isRepo === isRepo) {
          listeners.latest = { ...previous, observation };
          return;
        }
        const branch = { refName, isRepo, observation, revision: (previous?.revision ?? 0) + 1 };
        listeners.latest = branch;
        yield* PubSub.publish(listeners.updates, branch);
      }).pipe(Effect.uninterruptible),
    );
  });

  return { subscribe, publish, latest: (cwd: string) => listenersByCwd.get(cwd)?.latest };
});
