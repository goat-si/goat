// @effect-diagnostics globalTimers:off - electron-updater calls this synchronously from its request callbacks, outside an Effect runtime.
/** The parts of Electron's net.ClientRequest a request deadline needs. */
export interface TimedRequest {
  readonly on: (event: string, listener: () => void) => unknown;
  readonly abort: () => void;
}

export type StartTimer = (run: () => void, delayMs: number) => () => void;

const startNodeTimer: StartTimer = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
};

/**
 * builder-util-runtime arms its request timeout on a "socket" event, which Electron's
 * net.ClientRequest never emits, so under Electron an updater request that stalls never
 * settles. This deadline runs on the request itself and ends once the response starts,
 * so a slow download keeps streaming while a request that never answers fails.
 */
export function addResponseDeadline(
  request: TimedRequest,
  fail: (error: Error) => void,
  timeoutMs: number,
  startTimer: StartTimer = startNodeTimer,
): void {
  const cancel = startTimer(() => {
    request.abort();
    fail(new Error(`Request timed out after ${timeoutMs} ms without a response`));
  }, timeoutMs);
  for (const event of ["response", "error", "abort", "close"]) request.on(event, cancel);
}
