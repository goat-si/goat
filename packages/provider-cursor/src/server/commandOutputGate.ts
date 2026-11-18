import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

/** Characters of live command output one session's event queue may hold: at most 8 MiB. */
const COMMAND_OUTPUT_QUEUE_CHARS = 4 * 1024 * 1024;

/**
 * Bounds live command output waiting in an adapter's event queue. A delta past the bound waits
 * until the reader takes earlier output; once its turn stops or the session closes it is dropped,
 * so it never reaches the reader after its item completed. Domain events never pass through here.
 */
export const makeCommandOutputGate = Effect.fnUntraced(function* (
  capacity: number = COMMAND_OUTPUT_QUEUE_CHARS,
) {
  let queued = 0;
  let closed = false;
  let wake = yield* Deferred.make<void>();
  const wakeAll = Effect.gen(function* () {
    const woken = wake;
    wake = yield* Deferred.make<void>();
    yield* Deferred.succeed(woken, undefined);
  });
  const charge = (chunk: string) => Math.min(chunk.length, capacity);
  return {
    queued: () => queued,
    /** Offers the delta once it fits; false when it was dropped because its turn stopped. */
    offer: Effect.fnUntraced(function* <A>(
      queue: Queue.Queue<A>,
      event: A,
      chunk: string,
      stopped: () => boolean,
    ) {
      while (true) {
        if (closed || stopped()) return false;
        if (queued === 0 || queued + charge(chunk) <= capacity) {
          queued += charge(chunk);
          yield* Queue.offer(queue, event);
          return true;
        }
        yield* Deferred.await(wake);
      }
    }),
    /** Takes the next event for the reader, freeing the room a delta held. */
    take: (queue: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>) =>
      Queue.take(queue).pipe(
        Effect.tap((event) =>
          Effect.suspend(() => {
            if (event.type !== "command_output.delta") return Effect.void;
            queued -= charge(event.chunk);
            return wakeAll;
          }),
        ),
      ),
    /** A turn stopped: waiting deltas re-check and drop. */
    wakeAll,
    close: Effect.suspend(() => {
      closed = true;
      return wakeAll;
    }),
  };
});
