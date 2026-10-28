// @effect-diagnostics globalTimers:off - The lock orders Playwright promises outside the Effect runtime.
import type { PreviewAutomationRequest, PreviewAutomationWaitForInput } from "@goat/contracts";
import { constVoid } from "effect/Function";

import { ServerBrowserOperationError } from "./ServerBrowserPage.ts";

export interface CaptureLockHolder {
  captureLock: Promise<void>;
  readonly closing: boolean;
}

const notDrawnInTime = () =>
  new ServerBrowserOperationError(
    "PreviewAutomationTimeoutError",
    "The browser did not draw the page for a capture in time. Try again in a moment.",
  );

/** An agent call still queued or running at its deadline; an earlier call may hold the tab. */
const tabBusy = () =>
  new ServerBrowserOperationError(
    "PreviewAutomationTimeoutError",
    "This tab did not finish the call in time; an earlier call may still be running. Try again in a moment.",
  );

/** A wait that never started cannot say its condition is unmet, so it fails instead of timing out. */
const waitNotStarted = () =>
  new ServerBrowserOperationError(
    "PreviewAutomationExecutionError",
    "The wait did not start before its deadline; an earlier call held this tab. Check again.",
  );

/** A wait's input once it starts: the time it spent queued behind the tab's other work is gone. */
export const waitInput = (
  request: Pick<PreviewAutomationRequest, "input" | "timeoutMs">,
  deadlineMs: number,
): PreviewAutomationWaitForInput => {
  const timeoutMs = Math.min(request.timeoutMs, deadlineMs - performance.now());
  if (timeoutMs <= 0) throw waitNotStarted();
  return { ...(request.input as PreviewAutomationWaitForInput), timeoutMs };
};

/**
 * Answers the caller by its deadline while the work itself goes on; onExpire runs when the
 * deadline wins.
 */
export const answerBy = <A>(
  work: Promise<A>,
  deadlineMs: number,
  onExpire: () => void = constVoid,
  timeout: () => Error = notDrawnInTime,
): Promise<A> => {
  if (deadlineMs === Number.POSITIVE_INFINITY) return work;
  return new Promise<A>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        onExpire();
        reject(timeout());
      },
      Math.max(0, deadlineMs - performance.now()),
    );
    work.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (cause: unknown) => (clearTimeout(timer), reject(cause)),
    );
  });
};

/**
 * One capture at a time per tab. The lock follows the capture itself, which CDP cannot cancel,
 * so the next capture never overlaps one still in flight. A deadline bounds only how long the
 * caller waits: `answer` settles by then, while `run` is the capture itself, for state that must
 * follow it. A capture whose turn comes after its deadline never runs. A desktop guest that is
 * not drawing answers no screenshot (#1084), and without this an agent's snapshot waited behind a
 * viewer's still until the broker cut the whole host off.
 */
export const queueCaptureBy =
  (deadlineMs = Number.POSITIVE_INFINITY) =>
  <A>(tab: CaptureLockHolder, operation: () => Promise<A>) => {
    let expired = false;
    const run = tab.captureLock.then(() => {
      if (tab.closing) throw new Error("The preview tab closed.");
      // Its turn can come before the timer that marks it expired has run.
      if (expired || performance.now() >= deadlineMs) throw notDrawnInTime();
      return operation();
    });
    tab.captureLock = run.then(constVoid, constVoid);
    const answer = answerBy(run, deadlineMs, () => {
      expired = true;
    });
    return { run, answer };
  };

export const withCaptureLock = <A>(
  tab: CaptureLockHolder,
  operation: () => Promise<A>,
  deadlineMs = Number.POSITIVE_INFINITY,
): Promise<A> => queueCaptureBy(deadlineMs)(tab, operation).answer;
/**
 * Runs one agent call against its deadline. Calls queue per tab, so one still waiting then is
 * answered here, before the broker gives up on the whole host; half a second lets the call's own
 * timeout answer first.
 */
export const answerCall = <A>(
  request: { readonly timeoutMs: number; readonly operation: string },
  call: (deadlineMs: number) => Promise<A>,
) => {
  const deadlineMs = performance.now() + request.timeoutMs;
  const late = request.operation === "waitFor" ? waitNotStarted : tabBusy;
  return answerBy(call(deadlineMs), deadlineMs + 500, constVoid, late);
};
