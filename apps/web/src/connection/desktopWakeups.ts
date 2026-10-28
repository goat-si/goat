import type { Wakeups } from "@goat/client-runtime/connection";
import type { DesktopBridge, DesktopSystemWakeEvent } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

// Long sleep checks stale sockets with the shorter resume probe budget.
export const DESKTOP_LONG_SLEEP_AFTER_MS = 10_000;
/** Window focus checks connections at most this often; a quick app switch needs no check. */
export const FOCUS_PROBE_MIN_INTERVAL_MS = 30_000;

export type DesktopWakeup = Extract<
  Wakeups.ConnectionWakeup,
  "suspend" | "application-active-probe" | "application-active-long"
>;

export function desktopSystemWakeup(event: DesktopSystemWakeEvent): DesktopWakeup {
  if (event.reason === "suspend") return "suspend";
  if (event.reason !== "resume") return "application-active-probe";
  // A resume without a recorded suspend still followed a sleep of unknown length.
  return event.asleepMs === null || event.asleepMs >= DESKTOP_LONG_SLEEP_AFTER_MS
    ? "application-active-long"
    : "application-active-probe";
}

export interface DesktopWakeupSources {
  readonly onSystemWake: NonNullable<DesktopBridge["onSystemWake"]>;
  readonly window: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  readonly nowMs: () => number;
}

/**
 * Connection wakeups only the desktop shell can report: waking from sleep and
 * unlocking the screen. Window focus and the browser's online event become
 * quick probes there too, since a laptop lid can close and open without the
 * page ever turning hidden. Focus is skipped right after another wakeup.
 */
export function desktopWakeups(sources: DesktopWakeupSources): Stream.Stream<DesktopWakeup> {
  return Stream.callback<DesktopWakeup>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let lastWakeupAtMs = Number.NEGATIVE_INFINITY;
        let lastSystemWakeAtMs = Number.NEGATIVE_INFINITY;
        let lastSystemWakeup: DesktopWakeup | null = null;
        const emit = (wakeup: DesktopWakeup) => {
          lastWakeupAtMs = sources.nowMs();
          Queue.offerUnsafe(queue, wakeup);
        };
        const onFocus = () => {
          if (sources.nowMs() - lastWakeupAtMs >= FOCUS_PROBE_MIN_INTERVAL_MS) {
            emit("application-active-probe");
          }
        };
        const onOnline = () => emit("application-active-probe");
        const unsubscribe = sources.onSystemWake((event) => {
          const now = sources.nowMs();
          const wakeup = desktopSystemWakeup(event);
          if (wakeup === "suspend") {
            lastSystemWakeAtMs = Number.NEGATIVE_INFINITY;
            lastSystemWakeup = null;
            // Suspend checks nothing, so the next focus must still probe in case resume never arrives.
            lastWakeupAtMs = Number.NEGATIVE_INFINITY;
            Queue.offerUnsafe(queue, wakeup);
            return;
          }
          // A resume whose suspend came after the last wake is a new sleep, never a duplicate.
          const sleptSinceLastWake =
            event.reason === "resume" &&
            event.asleepMs !== null &&
            event.asleepMs <= now - lastSystemWakeAtMs;
          if (
            !sleptSinceLastWake &&
            now - lastSystemWakeAtMs < DESKTOP_LONG_SLEEP_AFTER_MS &&
            (lastSystemWakeup === "application-active-long" || lastSystemWakeup === wakeup)
          ) {
            lastWakeupAtMs = now;
            return;
          }
          lastSystemWakeAtMs = now;
          lastSystemWakeup = wakeup;
          emit(wakeup);
        });
        sources.window.addEventListener("focus", onFocus);
        sources.window.addEventListener("online", onOnline);
        return () => {
          unsubscribe();
          sources.window.removeEventListener("focus", onFocus);
          sources.window.removeEventListener("online", onOnline);
        };
      }),
      (cleanup) => Effect.sync(cleanup),
    ).pipe(Effect.asVoid),
  );
}
