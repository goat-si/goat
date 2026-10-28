import type { Page } from "playwright-core";

/** How a snapshot recovers from a capture the page interrupted, kept free of Playwright so it can be tested. */
export interface SnapshotRetryInput<A> {
  readonly capture: () => Promise<A>;
  /** Resolves once the page has fired `load`, or rejects after `timeoutMs`. */
  readonly waitForLoad: (timeoutMs: number) => Promise<unknown>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly deadline: number;
  /** Whether this snapshot is still the page's latest; a later one owns the refs. */
  readonly current: () => boolean;
  /** Whether a failed capture may be tried again. */
  readonly retryable: (cause: unknown) => boolean;
  readonly tooBusy: () => Error;
}

/** Captures once and, when the page interrupted it, once more if the deadline allows. */
export const snapshotRetry = <A>(input: SnapshotRetryInput<A>): Promise<A> =>
  input
    .capture()
    .catch((cause: unknown) =>
      input.now() < input.deadline && input.current() && input.retryable(cause)
        ? input.capture()
        : Promise.reject(cause),
    );

/** Snapshots begun per page; observers' snapshots aren't queued, so two can overlap. */
const snapshotTurns = new WeakMap<Page, number>();

/**
 * Runs one page snapshot within `timeoutMs`: captures, retries per `snapshotRetry` until the
 * deadline or a newer snapshot of the page, and answers `tooBusy` when the time runs out.
 */
export const runSnapshot = async <A>(input: {
  readonly page: Page;
  readonly timeoutMs: number;
  readonly capture: (deadline: number) => Promise<A>;
  readonly retryable: (cause: unknown) => boolean;
  readonly tooBusy: () => Error;
}): Promise<A> => {
  const deadline = Date.now() + input.timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(input.tooBusy()), input.timeoutMs);
  });
  const turn = (snapshotTurns.get(input.page) ?? 0) + 1;
  snapshotTurns.set(input.page, turn);
  const captured = snapshotRetry({
    capture: () => input.capture(deadline),
    waitForLoad: (timeout) => input.page.waitForLoadState("load", { timeout }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    deadline,
    current: () => snapshotTurns.get(input.page) === turn,
    retryable: input.retryable,
    tooBusy: input.tooBusy,
  });
  try {
    return await Promise.race([captured, expired]);
  } catch (cause) {
    throw cause instanceof Error && cause.name === "TimeoutError" ? input.tooBusy() : cause;
  } finally {
    clearTimeout(timer);
    // CDP cannot cancel a capture: the caller's capture lock and paused screencasts wait for the
    // one Chromium still owes, so no second capture runs beside it. The caller's own deadline
    // answers it meanwhile (CaptureLock).
    await captured.then(
      () => undefined,
      () => undefined,
    );
  }
};
