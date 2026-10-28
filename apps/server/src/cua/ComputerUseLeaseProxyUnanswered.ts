/**
 * A server call its driver leaves unanswered past the call's deadline: the server already failed
 * it and later calls would queue behind the stuck child, so the child is replaced. The cut-off
 * answers what it held and releases its reservations; the next call reaches a fresh driver.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Semaphore from "effect/Semaphore";

import type { Interruption } from "./ComputerUseLeaseMessages.ts";

/** Lets a reply already on its way land before the child is judged stuck. */
const UNANSWERED_GRACE_MS = 1_000;

const DRIVER_UNANSWERED: Interruption = {
  _tag: "other",
  detail: "helper_restarted",
  message:
    "The driver did not answer a call within its deadline, so GOAT started it again. Observe again before acting.",
};

export const makeUnansweredWatch = <E>(
  proxy: {
    readonly lock: Semaphore.Semaphore;
    readonly scope: Scope.Scope;
    readonly outstanding: ReadonlyMap<string, { readonly connectionId: string }>;
    readonly lifecycle: { readonly current: { readonly connectionId: string } | undefined };
  },
  act: {
    readonly active: () => boolean;
    readonly interrupt: (cause: Interruption) => Effect.Effect<number>;
    readonly start: (token: number) => Effect.Effect<void, E>;
    readonly end: (reason: "lost") => Effect.Effect<void>;
  },
) => {
  const replace = Effect.fn("ComputerUseLeaseProxy.replaceUnanswered")(function* (key: string) {
    const call = proxy.outstanding.get(key);
    if (call === undefined || proxy.lifecycle.current?.connectionId !== call.connectionId) return;
    if (!act.active()) return;
    const token = yield* act.interrupt(DRIVER_UNANSWERED);
    if (act.active()) yield* act.start(token);
  });
  return (key: string, deadlineMillis: number) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => {
        const wait = deadlineMillis + UNANSWERED_GRACE_MS - now;
        return wait > 0 ? Effect.sleep(wait) : Effect.void;
      }),
      Effect.andThen(proxy.lock.withPermits(1)(replace(key).pipe(Effect.uninterruptible))),
      Effect.catchCause(() => act.end("lost")),
      Effect.forkIn(proxy.scope),
      Effect.asVoid,
    );
};
