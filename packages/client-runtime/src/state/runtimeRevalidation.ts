import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

const isStale = (result: AsyncResult.AsyncResult<unknown, unknown>, staleTimeMs: number) => {
  if (result.waiting) return false;
  const success =
    result._tag === "Failure" ? Option.getOrUndefined(result.previousSuccess) : result;
  if (success?._tag !== "Success") return result._tag === "Failure";
  // @effect-diagnostics-next-line globalDate:off - `AsyncResult` timestamps come from `Date.now`.
  return Date.now() - success.timestamp >= staleTimeMs;
};

/**
 * Stale-while-revalidate on direct mounts. `Atom.swr` checks only when its node builds, which an idle
 * TTL skips on a remount; this layer has no TTL (a transform drops it) while `self` keeps the cache.
 * It reads `self` as a dependency, not a subscription, so `self` goes idle with its last reader.
 */
export const revalidateOnMount =
  (staleTimeMs: number) =>
  <A, E>(
    self: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  ): Atom.Atom<AsyncResult.AsyncResult<A, E>> => {
    const wrapper = Atom.transform(
      self,
      (get) => {
        const current = get(self);
        if (Option.isNone(get.self()) && isStale(current, staleTimeMs)) {
          let active = true;
          get.addFinalizer(() => {
            active = false;
          });
          // A derived reader can briefly drop this dependency without closing its view.
          get.registry.schedulerAsync.makeDispatcher().scheduleTask(() => {
            if (
              active &&
              (get.registry.getNodes().get(wrapper)?.listeners.size ?? 0) > 0 &&
              isStale(get.once(self), staleTimeMs)
            )
              get.refresh(self);
          }, 0);
        }
        return current;
      },
      { initialValueTarget: self },
    );
    return wrapper;
  };
