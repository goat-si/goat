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

/** Time kept back from the deadline for the capture that follows a wait. */
const CAPTURE_RESERVE_MS = 500;
/** The shortest wait for load worth starting; Playwright treats a timeout of 0 as none. */
const MIN_WAIT_MS = 250;
/** A loaded page whose content still moves gets this long before the next capture. */
const SETTLE_MS = 250;
const MAX_RETRIES = 2;

/**
 * Captures and, when the page interrupted the capture (often because it is still loading), waits
 * for `load` and a short settle, then captures again: at most twice, and only with time left.
 */
export const snapshotRetry = async <A>(input: SnapshotRetryInput<A>): Promise<A> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await input.capture();
    } catch (cause) {
      if (!input.current() || !input.retryable(cause)) throw cause;
      const wait = input.deadline - input.now() - CAPTURE_RESERVE_MS;
      if (attempt >= MAX_RETRIES || wait < MIN_WAIT_MS) throw input.tooBusy();
      await input.waitForLoad(wait).catch(() => undefined);
      await input.sleep(Math.min(SETTLE_MS, Math.max(0, input.deadline - input.now())));
      if (input.now() >= input.deadline || !input.current()) throw input.tooBusy();
    }
  }
};

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
