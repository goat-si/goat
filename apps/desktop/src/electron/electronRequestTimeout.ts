// @effect-diagnostics globalTimers:off - electron-updater calls this synchronously from its request callbacks, outside an Effect runtime.
/** The parts of Electron's net.ClientRequest and IncomingMessage a request deadline needs. */
export interface TimedEmitter {
  readonly on: (event: string, listener: (value?: unknown) => void) => unknown;
}

export interface TimedRequest extends TimedEmitter {
  readonly abort: () => void;
}

export type StartTimer = (run: () => void, delayMs: number) => () => void;

/** electron-updater rejects the check or download with this error, so the update UI can name the stall. */
export class UpdaterRequestStalledError extends Error {
  override readonly name = "UpdaterRequestStalledError";
  constructor(timeoutMs: number) {
    super(`the update server sent no data for ${Math.round(timeoutMs / 1000)} seconds`);
  }
}

const startNodeTimer: StartTimer = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
};

function isEmitter(value: unknown): value is TimedEmitter {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "on") === "function"
  );
}

/**
 * builder-util-runtime gives each updater request an idle timeout through Node's
 * socket.setTimeout, armed on a "socket" event that Electron's net.ClientRequest never
 * emits, so under Electron a stalled request never settles. This restores that idle
 * timeout on the request and its response: it fails the request when no data arrives for
 * timeoutMs, before or during the response body, so a streaming download stays alive and
 * a feed that stops sending fails. Request "close" is not an ending: Electron's request is
 * a Writable that closes once its body is sent, before any response.
 */
export function addIdleDeadline(
  request: TimedRequest,
  fail: (error: Error) => void,
  timeoutMs: number,
  startTimer: StartTimer = startNodeTimer,
): void {
  let settled = false;
  let cancel = () => {};
  const settle = () => {
    settled = true;
    cancel();
  };
  const arm = () => {
    cancel();
    if (settled) return;
    cancel = startTimer(() => {
      settled = true;
      request.abort();
      fail(new UpdaterRequestStalledError(timeoutMs));
    }, timeoutMs);
  };
  arm();
  request.on("response", (response) => {
    arm();
    if (!isEmitter(response)) return;
    response.on("data", arm);
    for (const event of ["end", "error", "aborted"]) response.on(event, settle);
  });
  for (const event of ["error", "abort"]) request.on(event, settle);
}
