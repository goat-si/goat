import type { DesktopCuaDriverRequest } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

/**
 * Records the start a host serves now. The ones it served before are superseded: a late Stop of
 * one of them must leave the host to the newer start.
 */
export const serve = (host: { serving?: string; superseded?: Set<string> }, requestId: string) => {
  if (host.serving !== undefined && host.serving !== requestId)
    (host.superseded ??= new Set()).add(host.serving);
  host.serving = requestId;
};

/**
 * Handles requests in order, one at a time under the driver's lock, but notes a Stop as it
 * arrives. A start and its Stop share a request id, so the start a Stop names can be cut short
 * instead of holding the Stop in the queue until it gives up; the Stop itself is still handled in
 * its turn and reports.
 */
export const makeStopFirstRequests = () => {
  let handling: string | undefined;
  const stopped = new Set<string>();
  // One request at a time: the next one queues for the driver's lock only once this one is done,
  // so work already waiting for that lock, such as a crash, still goes first.
  const inTurn = Semaphore.makeUnsafe(1);
  return {
    /** Whether the Stop of this start has arrived. */
    stopped: (requestId: string) => stopped.has(requestId),
    /** retire runs as a Stop arrives for the start being handled, which holds the lock. */
    handle: <E, R>(
      requests: Stream.Stream<DesktopCuaDriverRequest>,
      handle: (request: DesktopCuaDriverRequest) => Effect.Effect<void, E, R>,
      locked: (effect: Effect.Effect<void, E, R>) => Effect.Effect<void, E, R>,
      retire: () => void,
    ) =>
      Stream.runForEach(requests, (request) =>
        Effect.suspend(() => {
          if (!request.enabled) {
            stopped.add(request.requestId);
            if (handling === request.requestId) retire();
          }
          // Started at once, so each takes its turn in arrival order: the semaphore wakes waiters
          // in order.
          return Effect.forkScoped(
            inTurn.withPermits(1)(
              locked(
                Effect.suspend(() => {
                  handling = request.enabled ? request.requestId : undefined;
                  return handle(request);
                }).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      handling = undefined;
                      if (!request.enabled) stopped.delete(request.requestId);
                    }),
                  ),
                ),
              ),
            ),
            { startImmediately: true },
          );
        }),
      ),
  };
};
