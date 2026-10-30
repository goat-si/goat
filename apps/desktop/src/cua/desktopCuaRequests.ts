import type { DesktopCuaDriverRequest } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

/**
 * Handles requests in order, one at a time under the driver's lock, but notes a Stop as it
 * arrives. A start and its Stop share a request id, so the start a Stop names can be cut short
 * instead of holding the Stop in the queue until it gives up; the Stop itself is still handled in
 * its turn and reports.
 */
export const makeStopFirstRequests = () => {
  let handling: string | undefined;
  const stopped = new Set<string>();
  // Starts handled and not yet stopped, and the newest of them.
  const started = new Set<string>();
  let latest: string | undefined;
  // One request at a time: the next one queues for the driver's lock only once this one is done,
  // so work already waiting for that lock, such as a crash, still goes first.
  const inTurn = Semaphore.makeUnsafe(1);
  return {
    /** Whether the Stop of this start has arrived. */
    stopped: (requestId: string) => stopped.has(requestId),
    /**
     * Whether a newer start was handled after this one, however far this one got: its Stop then
     * belongs to a session that is over and must leave the newer one's host alone. A Stop under
     * an id that never started is not late.
     */
    late: (requestId: string) => started.has(requestId) && latest !== requestId,
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
                  if (request.enabled) {
                    started.add(request.requestId);
                    latest = request.requestId;
                  }
                  return handle(request);
                }).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      handling = undefined;
                      if (request.enabled) return;
                      stopped.delete(request.requestId);
                      started.delete(request.requestId);
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
