/**
 * A server call its driver leaves unanswered past the call's deadline: the server already failed
 * it and later calls would queue behind the stuck child, so the child is replaced. The cut-off
 * answers what it held and releases its reservations; the next call reaches a fresh driver.
 */
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Semaphore from "effect/Semaphore";

import { type Interruption, targetClosedInterruption } from "./ComputerUseLeaseMessages.ts";
import { PRIMITIVE_ID } from "./ComputerUseLeaseProxyOptions.ts";

/** Lets a reply already on its way land before the child is judged stuck. */
const UNANSWERED_GRACE_MS = 1_000;

const DRIVER_UNANSWERED: Interruption = {
  _tag: "other",
  detail: "helper_restarted",
  message:
    "The driver did not answer a call within its deadline, so GOAT started it again. Observe again before acting.",
};

const replyKey = (line: string): string | undefined => {
  if (!line.includes(PRIMITIVE_ID)) return undefined;
  try {
    const id: unknown = (JSON.parse(line) as { id?: unknown }).id;
    return typeof id === "string" && id.startsWith(PRIMITIVE_ID) ? JSON.stringify(id) : undefined;
  } catch {
    return undefined;
  }
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
    /** What a call refused at the fence is told, before the interruption itself records it. */
    readonly fenced: (cause: Interruption) => void;
  },
) => {
  // Marked as each line leaves the driver, ahead of the replies GOAT is still checking in order.
  const replied = new Set<string>();
  // The chain a private or taken-over target closed; no call reaches it until it is replaced.
  let fenced: string | undefined;
  // Calls past their deadline, by key, until a reply lands or their grace ends. A new call to the
  // same chain waits for that outcome instead of queueing behind a child that may be stuck.
  const overdue = new Map<string, string>();
  let settled = Deferred.makeUnsafe<void>();
  const settle = (key: string) => {
    if (!overdue.delete(key)) return;
    Deferred.doneUnsafe(settled, Effect.void);
    settled = Deferred.makeUnsafe<void>();
  };
  const replace = Effect.fn("ComputerUseLeaseProxy.replaceUnanswered")(function* (key: string) {
    if (replied.delete(key)) return;
    const call = proxy.outstanding.get(key);
    if (call === undefined || proxy.lifecycle.current?.connectionId !== call.connectionId) return;
    if (!act.active()) return;
    const token = yield* act.interrupt(DRIVER_UNANSWERED);
    if (act.active()) yield* act.start(token);
  });
  const closeTarget = Effect.fn("ComputerUseLeaseProxy.closeTarget")(function* (
    reason: "private" | "takeover",
    connectionId: string,
  ) {
    // An overtaking restart already replaced the chain this hide was meant for.
    if (!act.active() || proxy.lifecycle.current?.connectionId !== connectionId) {
      if (fenced === connectionId) fenced = undefined;
      return;
    }
    const token = yield* act.interrupt(targetClosedInterruption(reason));
    fenced = undefined;
    if (act.active()) yield* act.start(token);
  });
  return {
    /** Whether calls to this chain are held back while it is being replaced. */
    blocks: (connectionId: string) => fenced === connectionId,
    fenceTarget: (reason: "private" | "takeover", connectionId: string) => {
      fenced = connectionId;
      act.fenced(targetClosedInterruption(reason));
    },
    closeTarget: (reason: "private" | "takeover", connectionId: string) =>
      proxy.lock
        .withPermits(1)(closeTarget(reason, connectionId).pipe(Effect.uninterruptible))
        .pipe(Effect.catchCause(() => act.end("lost"))),
    /**
     * Waits while this chain has an overdue call: its late reply sends the waiting call on to the
     * same child, while a replacement, failure or end leaves it to be refused, nothing sent.
     */
    hold: Effect.fn("ComputerUseLeaseProxy.holdForOverdue")(function* (
      connectionId: string,
      untilMillis: number,
    ) {
      while ([...overdue.values()].includes(connectionId)) {
        const now = yield* Clock.currentTimeMillis;
        if (now >= untilMillis) return;
        const wake = Deferred.await(settled);
        yield* Number.isFinite(untilMillis)
          ? wake.pipe(
              Effect.timeoutOrElse({ duration: untilMillis - now, orElse: () => Effect.void }),
            )
          : wake;
      }
    }),
    /** Every line the driver writes, as it arrives. */
    received: (line: string) =>
      Effect.sync(() => {
        const key = replyKey(line);
        if (key === undefined) return;
        if (proxy.outstanding.has(key)) replied.add(key);
        settle(key);
      }),
    watch: (key: string, deadlineMillis: number) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => Effect.sleep(Math.max(0, deadlineMillis - now))),
        Effect.andThen(
          Effect.sync(() => {
            const call = proxy.outstanding.get(key);
            if (call !== undefined && !replied.has(key)) overdue.set(key, call.connectionId);
          }),
        ),
        Effect.andThen(Effect.sleep(UNANSWERED_GRACE_MS)),
        Effect.andThen(proxy.lock.withPermits(1)(replace(key).pipe(Effect.uninterruptible))),
        Effect.catchCause(() => act.end("lost")),
        Effect.ensuring(Effect.sync(() => settle(key))),
        Effect.forkIn(proxy.scope),
        Effect.asVoid,
      ),
  };
};
