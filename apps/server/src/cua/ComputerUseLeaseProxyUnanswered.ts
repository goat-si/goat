import { driverCallCapMs } from "./ComputerUseCallCaps.ts";
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

/** Lets a reply already on its way land before the child is judged stuck. */
const UNANSWERED_GRACE_MS = 1_000;

const DRIVER_UNANSWERED: Interruption = {
  _tag: "other",
  detail: "helper_restarted",
  message:
    "The driver did not answer a call within its deadline, so GOAT started it again. Observe again before acting.",
};

const replyKey = (line: string): string | undefined => {
  try {
    const parsed = JSON.parse(line) as { id?: unknown; method?: unknown };
    return parsed.method !== undefined || parsed.id === undefined || parsed.id === null
      ? undefined
      : JSON.stringify(parsed.id);
  } catch {
    return undefined;
  }
};

export const makeUnansweredWatch = <E>(
  proxy: {
    readonly lock: Semaphore.Semaphore;
    readonly scope: Scope.Scope;
    readonly outstanding: ReadonlyMap<
      string,
      {
        readonly connectionId: string;
        readonly tool?: string | undefined;
        readonly args?: unknown;
        readonly sentAt?: number | undefined;
      }
    >;
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
  // When the current head call of each connection reached the front of the pipe.
  const headByConn = new Map<string, { readonly key: string; readonly since: number }>();
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
  const currentHead = (connectionId: string, now: number, advanced = false) => {
    for (const [k, each] of proxy.outstanding) {
      if (each.connectionId !== connectionId || replied.has(k)) continue;
      const prev = headByConn.get(connectionId);
      const since = prev?.key === k ? prev.since : advanced ? now : (each.sentAt ?? now);
      if (prev?.key !== k) headByConn.set(connectionId, { key: k, since });
      return { key: k, call: each, since };
    }
    headByConn.delete(connectionId);
    return undefined;
  };
  /**
   * The chain is gone or closing: calls held for it wake now, before its cleanup and before a new
   * driver is acquired. Only the current chain takes the fence, so a stale cleanup never lifts a
   * newer chain's; connection ids are never reused, so a fence can stay until the next one.
   */
  const close = (connectionId: string, current: boolean) => {
    if (current) fenced = connectionId;
    headByConn.delete(connectionId);
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
      Clock.currentTimeMillis.pipe(
        Effect.tap((now) =>
          Effect.sync(() => {
            const key = replyKey(line);
            if (key === undefined) return;
            for (const k of replied) if (!proxy.outstanding.has(k)) replied.delete(k);
            const answered = proxy.outstanding.get(key);
            if (answered !== undefined) {
              const wasHead = currentHead(answered.connectionId, now)?.key === key;
              replied.add(key);
              currentHead(answered.connectionId, now, wasHead);
            }
            overdue.delete(key);
            wake();
          }),
        ),
        Effect.asVoid,
      ),
    // Every primitive call forks one watch; untraced to avoid a span per background timer.
    watch: Effect.fnUntraced(
      function* (key: string, deadlineMillis: number) {
        const started = yield* Clock.currentTimeMillis;
        const budgetMs = Math.max(0, deadlineMillis - started);
        // Wait only while the currently blocking call at the head of the pipe is within its own
        // cap; if that head call remains unanswered through its grace window, replace immediately.
        for (;;) {
          const woken = Deferred.await(settled);
          const now = yield* Clock.currentTimeMillis;
          const call = proxy.outstanding.get(key);
          if (
            !call ||
            replied.has(key) ||
            proxy.lifecycle.current?.connectionId !== call.connectionId
          )
            return;
          const head = currentHead(call.connectionId, now);
          if (!head || head.key === key) break;
          const headDeadline = head.since + driverCallCapMs(head.call.tool ?? "", head.call.args);
          if (now < headDeadline) {
            const step = yield* woken.pipe(Effect.timeoutOption(headDeadline - now));
            if (Option.isSome(step)) continue;
          }
          const afterCap = yield* Clock.currentTimeMillis;
          if (currentHead(call.connectionId, afterCap)?.key !== head.key) continue;
          overdue.set(key, call.connectionId);
          const graceWoken = Deferred.await(settled);
          if (currentHead(call.connectionId, afterCap)?.key === head.key) {
            yield* graceWoken.pipe(Effect.timeoutOption(UNANSWERED_GRACE_MS));
          }
          const afterGrace = yield* Clock.currentTimeMillis;
          if (currentHead(call.connectionId, afterGrace)?.key === head.key) {
            yield* replace(key);
            return;
          }
          settle(key);
        }
        yield* Effect.sleep(budgetMs);
        const call = proxy.outstanding.get(key);
        if (call !== undefined && !replied.has(key)) overdue.set(key, call.connectionId);
        yield* Effect.sleep(UNANSWERED_GRACE_MS);
        yield* replace(key);
      },
      (effect, key) =>
        effect.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              for (const k of replied) if (!proxy.outstanding.has(k)) replied.delete(k);
              settle(key);
            }),
          ),
          Effect.forkIn(proxy.scope),
          Effect.asVoid,
        ),
    ),
  };
};
