import type { RunId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  identity,
  type LaunchWatch,
  type LaunchWatchTerminalStatus,
  type LaunchWatchWake,
  named,
  SUMMARY_MAX_CHARS,
  truncate,
  wakeIds,
} from "./launchWatch.ts";

/** What one follower step learned about the run it follows. */
export type StepResult =
  | {
      readonly _tag: "Terminal";
      readonly status: LaunchWatchTerminalStatus;
      /**
       * The run that ended: the followed one, or the running turn a queued
       * message was promoted into, which carries on its work.
       */
      readonly runId: RunId;
      /** When it ended, where the step could read it. */
      readonly end?: string | null;
    }
  | {
      readonly _tag: "Running";
      readonly questions: ReadonlyArray<{ readonly id: string; readonly kind: string | null }>;
      /** The run that asks them: a continuation or joined run of the followed one, else it. */
      readonly askedRunId?: RunId;
      readonly escalatesUserInput?: boolean;
      readonly retryIfNoNewQuestions?: boolean;
    }
  | { readonly _tag: "RunMissing" }
  | { readonly _tag: "Gone"; readonly reason: string }
  | { readonly _tag: "LauncherGone" }
  | { readonly _tag: "CallerChanged" }
  | { readonly _tag: "Unreachable"; readonly error: string };

/**
 * The pause before each restart of a follower that hit a defect. After the last, the launcher is
 * told the watch lost track; its runs stay pending and the next send or restart follows them again.
 */
export const FOLLOWER_RESTART_DELAYS_MS = [5_000, 10_000, 20_000] as const;
/** A follower that ran this long before its defect starts its restarts over. */
const FOLLOWER_HEALTHY_MS = 10 * 60_000;

/** Runs a watch's follower, restarting it with bounded backoff when it dies, then `lostTrack`. */
export const restartOnDefect =
  <R2>(watchId: string, lostTrack: () => Effect.Effect<unknown, never, R2>) =>
  <R>(follower: Effect.Effect<void, never, R>): Effect.Effect<void, never, R | R2> =>
    Effect.gen(function* () {
      let restarts = 0;
      while (true) {
        const startedAt = yield* Clock.currentTimeMillis;
        const exit = yield* Effect.exit(follower);
        if (Exit.isSuccess(exit)) return;
        if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt;
        if ((yield* Clock.currentTimeMillis) - startedAt >= FOLLOWER_HEALTHY_MS) restarts = 0;
        const delay = FOLLOWER_RESTART_DELAYS_MS[restarts];
        yield* Effect.logError("launch watch follower stopped", {
          watchId,
          restarts,
          cause: exit.cause,
        });
        if (delay === undefined) {
          yield* lostTrack();
          return;
        }
        restarts += 1;
        yield* Effect.sleep(delay);
      }
    });

/** What the launcher hears when its follower kept failing; keyed by the newest run, so each send gets one. */
export function lostTrackWake(watch: LaunchWatch): LaunchWatchWake {
  const name = named(watch, null);
  return {
    ...wakeIds(watch, `lost-track:${watch.incarnation}:${watch.pendingRuns.at(-1) ?? "idle"}`),
    text: `GOAT lost track of ${name.toLowerCase()} (${identity(watch)}); ${watch.host === null ? "the run" : "the remote run"} may still be running. Its follower failed ${FOLLOWER_RESTART_DELAYS_MS.length + 1} times in a row, so no end will be reported until your next goat_thread_send to it or a GOAT restart follows it again. Read it with goat_thread_status.`,
    notification: {
      source: { kind: "background_task" },
      outcome: "unknown",
      summary: truncate(`Lost track of ${name.toLowerCase()}`, SUMMARY_MAX_CHARS),
    },
  };
}
