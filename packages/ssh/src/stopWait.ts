const DEFAULT_STOP_WAIT_ATTEMPTS = 20;
const DEFAULT_STOP_WAIT_INTERVAL_SECONDS = "0.1";
const STOP_WAIT_INTERVAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

/** Production waits 20×0.1s. Tests pass interval `0` so the loop follows process exit. */
export function stopWaitPlaceholders(options: {
  readonly stopWaitAttempts?: number;
  readonly stopWaitIntervalSeconds?: string;
}): {
  readonly GOAT_STOP_WAIT_ATTEMPTS: string;
  readonly GOAT_STOP_WAIT_INTERVAL: string;
  readonly GOAT_STOP_WAIT_LABEL: string;
} {
  const attempts = options.stopWaitAttempts ?? DEFAULT_STOP_WAIT_ATTEMPTS;
  const interval = options.stopWaitIntervalSeconds ?? DEFAULT_STOP_WAIT_INTERVAL_SECONDS;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 1_000_000) {
    throw new Error(`stopWaitAttempts must be an integer from 1 to 1000000, got ${attempts}`);
  }
  if (!STOP_WAIT_INTERVAL_PATTERN.test(interval)) {
    throw new Error(`stopWaitIntervalSeconds must be a non-negative decimal, got ${interval}`);
  }
  return {
    GOAT_STOP_WAIT_ATTEMPTS: String(attempts),
    GOAT_STOP_WAIT_INTERVAL: interval,
    GOAT_STOP_WAIT_LABEL:
      attempts === DEFAULT_STOP_WAIT_ATTEMPTS && interval === DEFAULT_STOP_WAIT_INTERVAL_SECONDS
        ? "2 seconds"
        : "the stop deadline",
  };
}
