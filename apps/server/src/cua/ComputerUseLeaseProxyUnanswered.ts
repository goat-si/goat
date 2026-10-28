/**
 * A server call its driver leaves unanswered past the call's deadline: the server already failed
 * it and later calls would queue behind the stuck child, so the child is replaced. The cut-off
 * answers what it held and releases its reservations; the next call reaches a fresh driver.
 */
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
  const wake = () => {
    Deferred.doneUnsafe(settled, Effect.void);
    settled = Deferred.makeUnsafe<void>();
  };
  const settle = (key: string) => {
    if (overdue.delete(key)) wake();
  };
  /**
   * The chain is gone or closing: calls held for it wake now, before its cleanup and before a new
   * driver is acquired. Only the current chain takes the fence, so a stale cleanup never lifts a
   * newer chain's; connection ids are never reused, so a fence can stay until the next one.
   */
  const close = (connectionId: string, current: boolean) => {
    if (current) fenced = connectionId;
    for (const [key, chain] of overdue) if (chain === connectionId) overdue.delete(key);
    wake();
  };
  // Only the cutoff holds the lifecycle lock. Acquiring the new driver runs outside it, so a start
  // that never completes cannot hold a pause or end back; its revision token keeps a superseded
  // acquisition from publishing (ComputerUseLeaseProxyLifecycle.ts).
  const replaceUnder = (cause: Interruption, connectionId: string, due = () => true) =>
    proxy.lock
      .withPermits(1)(
        Effect.suspend(() => {
          const live = act.active() && proxy.lifecycle.current?.connectionId === connectionId;
          // Rechecked under the lock: a reply that landed while this waited keeps the child.
          if (live && !due()) return Effect.succeedNone;
          close(connectionId, live);
          return live ? act.interrupt(cause).pipe(Effect.asSome) : Effect.succeedNone;
        }).pipe(Effect.uninterruptible),
      )
      .pipe(
        // The new driver is acquired on its own fiber: the caller is done once the old chain is
        // cut off, and a pause or end supersedes an acquisition that never completes.
        Effect.flatMap((token) =>
          Option.isSome(token) && act.active()
            ? act.start(token.value).pipe(
                Effect.catchCause(() => act.end("lost")),
                Effect.forkIn(proxy.scope),
              )
            : Effect.void,
        ),
        Effect.catchCause(() => act.end("lost")),
        Effect.asVoid,
      );
  const replace = (key: string) =>
    Effect.suspend(() => {
      const call = proxy.outstanding.get(key);
      if (replied.has(key) || call === undefined) return Effect.void;
      return replaceUnder(
        DRIVER_UNANSWERED,
        call.connectionId,
        () => !replied.has(key) && proxy.outstanding.get(key) === call,
      );
    });
  return {
    /** Whether a call may not go to this chain now: it is closing, or has an overdue call. */
    blocks: (connectionId: string) =>
      fenced === connectionId || [...overdue.values()].includes(connectionId),
    fenceTarget: (reason: "private" | "takeover", connectionId: string) => {
      fenced = connectionId;
      act.fenced(targetClosedInterruption(reason));
    },
    closeTarget: (reason: "private" | "takeover", connectionId: string) =>
      replaceUnder(targetClosedInterruption(reason), connectionId),
    /**
     * Waits while the current chain has an overdue call, and says whether the call may still go
     * to that same child: its late reply lets it, while a replacement, failure, end or the call's
     * own deadline leaves it to be refused, nothing sent.
     */
    hold: Effect.fn("ComputerUseLeaseProxy.holdForOverdue")(function* (untilMillis: number) {
      const chain = proxy.lifecycle.current;
      if (chain === undefined) return true;
      for (;;) {
        // Taken before the check, so a wake between the check and the wait still ends the wait.
        const woken = Deferred.await(settled);
        if (![...overdue.values()].includes(chain.connectionId)) break;
        const now = yield* Clock.currentTimeMillis;
        if (now >= untilMillis) return false;
        yield* Number.isFinite(untilMillis)
          ? woken.pipe(
              Effect.timeoutOrElse({ duration: untilMillis - now, orElse: () => Effect.void }),
            )
          : woken;
      }
      return proxy.lifecycle.current === chain;
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
        Effect.andThen(replace(key)),
        Effect.ensuring(
          Effect.sync(() => {
            replied.delete(key);
            settle(key);
          }),
        ),
        Effect.forkIn(proxy.scope),
        Effect.asVoid,
      ),
  };
};
