import { constVoid } from "effect/Function";

import { ServerBrowserOperationError } from "./ServerBrowserPage.ts";

export interface CaptureLockHolder {
  captureLock: Promise<void>;
  readonly closing: boolean;
}

const notDrawnInTime = () =>
  new ServerBrowserOperationError(
    "PreviewAutomationTimeoutError",
    "The browser did not draw the page for a capture in time. Take another snapshot in a moment.",
  );

/**
 * One capture at a time per tab. The lock follows the capture itself, which CDP cannot cancel,
 * so the next capture never overlaps one still in flight. A deadline bounds only how long the
 * caller waits: it is answered then, and a capture whose turn comes after it never runs. A
 * desktop guest that is not drawing answers no screenshot (#1084), and without this an agent's
 * snapshot waited behind a viewer's still until the broker cut the whole host off.
 */
export const withCaptureLock = <A>(
  tab: CaptureLockHolder,
  operation: () => Promise<A>,
  deadlineMs = Number.POSITIVE_INFINITY,
): Promise<A> => {
  let expired = false;
  const run = tab.captureLock.then(() => {
    if (tab.closing) throw new Error("The preview tab closed.");
    if (expired) throw notDrawnInTime();
    return operation();
  });
  tab.captureLock = run.then(constVoid, constVoid);
  if (deadlineMs === Number.POSITIVE_INFINITY) return run;
  return new Promise<A>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        expired = true;
        reject(notDrawnInTime());
      },
      Math.max(0, deadlineMs - performance.now()),
    );
    run.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (cause: unknown) => (clearTimeout(timer), reject(cause)),
    );
  });
};
