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
import { driverBoolArg, driverIntegerArg } from "./ComputerUseCallCaps.ts";

/** Lets a reply already on its way land before the child is judged stuck. */
const UNANSWERED_GRACE_MS = 1_000;

const DRIVER_UNANSWERED: Interruption = {
  _tag: "other",
  detail: "helper_restarted",
  message:
    "The driver did not answer a call within its deadline, so GOAT started it again. Observe again before acting.",
};

const record = (args: unknown): Readonly<Record<string, unknown>> =>
  typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};

const windowStateBoundMs = (given: Readonly<Record<string, unknown>>): number => {
  const wantTree = driverBoolArg(given.include_accessibility_tree) !== false;
  const shouldCapture =
    driverBoolArg(given.include_screenshot) !== false ||
    typeof given.screenshot_out_file === "string";
  const raw = driverIntegerArg(given.timeout_ms);
  const walk = raw !== undefined ? Math.min(120_000, Math.max(100, raw)) : 2_000;
  return 2_000 + (wantTree ? walk * 2 + 5_000 : 0) + (shouldCapture ? 7_000 : 0);
};

const stepToolAndArgs = (
  raw: unknown,
): { readonly tool: string; readonly args: unknown } | undefined => {
  const step = record(raw);
  if (typeof step.tool === "string") return { tool: step.tool, args: step.args };
  const key = Object.keys(step).find(
    (k) => !["tool", "args", "wait_for", "expect", "timeout_ms"].includes(k),
  );
  return key === undefined ? undefined : { tool: key, args: step[key] };
};

const EXTRA_HEAD_BOUNDS_MS: Readonly<Record<string, number>> = {
  get_desktop_state: 7_000,
  set_window_frame: 5_000,
  kill_app: 5_000,
  check_for_update: 5_000,
  parse_visual_regions: 10_000,
  wait_for_window_settle: 12_000,
  page: 35_000,
  get_browser_state: 35_000,
  browser_prepare: 35_000,
  browser_navigate: 35_000,
  browser_click: 35_000,
  browser_type: 35_000,
  browser_select: 35_000,
  browser_pointer: 35_000,
  browser_dialog: 35_000,
  browser_set_input_files: 35_000,
  browser_download: 35_000,
  start_recording: 120_000,
  stop_recording: 120_000,
  replay_trajectory: 120_000,
  install_ffmpeg: 120_000,
  install_extension: 120_000,
};

/** Maximum legitimate execution bound of an earlier call on the driver before it is judged wedged. */
const headExecutionBoundMs = (tool: string, args: unknown): number => {
  const given = record(args);
  if (tool === "get_window_state") return windowStateBoundMs(given);
  if (tool === "type_text" || tool === "type_text_chars" || tool === "type") {
    const rawDelay = driverIntegerArg(given.delay_ms);
    const perChar = 24 + Math.min(200, Math.max(8, rawDelay ?? 30));
    const chars = typeof given.text === "string" ? [...given.text].length : 0;
    return 20_000 + perChar * chars;
  }
  if (tool === "verify_state") {
    const raw = driverIntegerArg(given.timeout_ms);
    const wait = raw !== undefined && raw <= 10_000 ? raw : 5_000;
    return wait + 11_000 + (driverBoolArg(given.include_screenshot) === true ? 9_000 : 0);
  }
  if (tool === "run_steps" || tool === "run_actions") {
    const obs = record(given.observe);
    let obsBound =
      driverBoolArg(given.observe) === false ? 18_000 : Math.max(18_000, windowStateBoundMs(obs));
    const steps = Array.isArray(given.steps) ? given.steps : [];
    let lastStepMs = 15_000;
    let tailReadsMs = 0;
    for (const rawStep of steps) {
      const parsed = stepToolAndArgs(rawStep);
      if (!parsed) continue;
      if (parsed.tool === "get_window_state") {
        obsBound = Math.max(obsBound, windowStateBoundMs({ ...record(parsed.args), ...obs }));
      } else if (parsed.tool.toLowerCase().includes("screenshot")) {
        obsBound = Math.max(obsBound, windowStateBoundMs({ ...obs, include_screenshot: true }));
      } else if (parsed.tool === "zoom") {
        tailReadsMs += 7_000;
        obsBound = Math.max(obsBound, windowStateBoundMs({ ...obs, include_screenshot: true }));
      } else {
        lastStepMs = Math.max(lastStepMs, headExecutionBoundMs(parsed.tool, parsed.args) + 60_000);
      }
    }
    return 60_000 + lastStepMs + obsBound + tailReadsMs;
  }
  return Math.max(EXTRA_HEAD_BOUNDS_MS[tool] ?? 0, driverCallCapMs(tool, args));
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
  const replied = new WeakSet<object>();
  // When the current head call of each connection reached the front of the pipe.
  const headByConn = new Map<string, { readonly call: object; readonly since: number }>();
  // The chain a private or taken-over target closed; no call reaches it until it is replaced.
  let fenced: string | undefined;
  // Watchers waiting out a grace window, keyed by the watcher's own request key so two watchers
  // never clear each other's fence.
  const overdue = new Map<
    string,
    { readonly connectionId: string; readonly blocking: object; readonly target: object }
  >();
  let settled = Deferred.makeUnsafe<void>();
  const wake = () => {
    Deferred.doneUnsafe(settled, Effect.void);
    settled = Deferred.makeUnsafe<void>();
  };
  const settle = (key: string) => {
    if (overdue.delete(key)) wake();
  };
  const hasOverdue = (connectionId: string) => {
    let found = false;
    for (const [k, entry] of overdue) {
      if (
        replied.has(entry.blocking) ||
        replied.has(entry.target) ||
        proxy.outstanding.get(k) !== entry.target
      ) {
        overdue.delete(k);
        continue;
      }
      if (entry.connectionId === connectionId) found = true;
    }
    return found;
  };
  const currentHead = (connectionId: string, now: number, advanced = false) => {
    for (const [k, each] of proxy.outstanding) {
      if (each.connectionId !== connectionId || replied.has(each)) continue;
      const prev = headByConn.get(connectionId);
      const since = prev?.call === each ? prev.since : advanced ? now : (each.sentAt ?? now);
      if (prev?.call !== each) headByConn.set(connectionId, { call: each, since });
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
    for (const [key, entry] of overdue)
      if (entry.connectionId === connectionId) overdue.delete(key);
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
  const replace = (
    blockingKey: string,
    blockingCall: { readonly connectionId: string },
    watcherKey: string,
    watcherTarget: object,
  ) =>
    Effect.suspend(() => {
      const isDue = () =>
        !replied.has(blockingCall) &&
        proxy.outstanding.get(blockingKey) === blockingCall &&
        !replied.has(watcherTarget) &&
        proxy.outstanding.get(watcherKey) === watcherTarget;
      if (!isDue()) return Effect.void;
      return replaceUnder(DRIVER_UNANSWERED, blockingCall.connectionId, isDue);
    });
  return {
    /** Whether a call may not go to this chain now: it is closing, or has an overdue call. */
    blocks: (connectionId: string) => fenced === connectionId || hasOverdue(connectionId),
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
        if (!hasOverdue(chain.connectionId)) break;
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
            const answered = proxy.outstanding.get(key);
            if (answered !== undefined) {
              const wasHead = currentHead(answered.connectionId, now)?.call === answered;
              replied.add(answered);
              currentHead(answered.connectionId, now, wasHead);
              for (const [k, entry] of overdue)
                if (entry.blocking === answered || entry.target === answered) overdue.delete(k);
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
        const target = proxy.outstanding.get(key);
        if (!target) return;
        // Wait only while the currently blocking call at the head of the pipe is within its own
        // cap; if that head call remains unanswered through its grace window, replace immediately.
        for (;;) {
          const woken = Deferred.await(settled);
          const now = yield* Clock.currentTimeMillis;
          const call = proxy.outstanding.get(key);
          if (
            call !== target ||
            replied.has(target) ||
            proxy.lifecycle.current?.connectionId !== call.connectionId
          )
            return;
          const head = currentHead(call.connectionId, now);
          if (!head || head.call === target) break;
          const headDeadline =
            head.since + headExecutionBoundMs(head.call.tool ?? "", head.call.args);
          if (now < headDeadline) {
            const step = yield* woken.pipe(Effect.timeoutOption(headDeadline - now));
            if (Option.isSome(step)) continue;
          }
          const afterCap = yield* Clock.currentTimeMillis;
          if (
            proxy.outstanding.get(key) !== target ||
            replied.has(target) ||
            proxy.lifecycle.current?.connectionId !== call.connectionId
          )
            return;
          if (currentHead(call.connectionId, afterCap)?.call !== head.call) continue;
          overdue.set(key, {
            connectionId: call.connectionId,
            blocking: head.call,
            target,
          });
          const graceEnd = afterCap + UNANSWERED_GRACE_MS;
          for (;;) {
            const graceWoken = Deferred.await(settled);
            const t = yield* Clock.currentTimeMillis;
            if (
              proxy.outstanding.get(key) !== target ||
              replied.has(target) ||
              proxy.lifecycle.current?.connectionId !== call.connectionId
            )
              return;
            if (currentHead(call.connectionId, t)?.call !== head.call || t >= graceEnd) break;
            const step = yield* graceWoken.pipe(Effect.timeoutOption(graceEnd - t));
            if (Option.isNone(step)) break;
          }
          const afterGrace = yield* Clock.currentTimeMillis;
          if (
            proxy.outstanding.get(key) !== target ||
            replied.has(target) ||
            proxy.lifecycle.current?.connectionId !== call.connectionId
          )
            return;
          if (currentHead(call.connectionId, afterGrace)?.call === head.call) {
            yield* replace(head.key, head.call, key, target);
          }
          settle(key);
        }
        const activeCall = proxy.outstanding.get(key);
        if (
          activeCall !== target ||
          replied.has(target) ||
          proxy.lifecycle.current?.connectionId !== activeCall.connectionId
        )
          return;
        yield* Effect.sleep(budgetMs);
        const call = proxy.outstanding.get(key);
        if (call === target && !replied.has(target))
          overdue.set(key, {
            connectionId: call.connectionId,
            blocking: target,
            target,
          });
        yield* Effect.sleep(UNANSWERED_GRACE_MS);
        yield* replace(key, target, key, target);
      },
      (effect, key) =>
        effect.pipe(
          Effect.ensuring(Effect.sync(() => settle(key))),
          Effect.forkIn(proxy.scope),
          Effect.asVoid,
        ),
    ),
  };
};
