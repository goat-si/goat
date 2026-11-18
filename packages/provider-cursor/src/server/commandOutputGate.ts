import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { copyOutputTail } from "./copyOutputTail.ts";

/** Characters of live command output one session's event queue may hold: at most 8 MiB. */
const COMMAND_OUTPUT_QUEUE_CHARS = 4 * 1024 * 1024;
const COMMAND_OUTPUT_QUEUE_EVENTS = 1024;

type CommandOutputDelta = Extract<
  ProviderAdapter.ProviderAdapterV2Event,
  { readonly type: "command_output.delta" }
>;

/**
 * Bounds live command output waiting in an adapter's event queue. A delta past the bound waits
 * until the reader takes earlier output; once its turn stops or the session closes it is dropped,
 * so it never reaches the reader after its item completed. Domain events never pass through here.
 */
export const makeCommandOutputGate = Effect.fnUntraced(function* (
  capacity: number = COMMAND_OUTPUT_QUEUE_CHARS,
) {
  let queued = 0;
  let queuedEvents = 0;
  let closed = false;
  let wake = yield* Deferred.make<void>();
  const wakeAll = Effect.gen(function* () {
    const woken = wake;
    wake = yield* Deferred.make<void>();
    yield* Deferred.succeed(woken, undefined);
  });
  const offer = Effect.fnUntraced(function* (
    queue: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>,
    event: CommandOutputDelta,
    stopped: () => boolean,
  ) {
    while (true) {
      if (closed || stopped()) return false;
      if (queuedEvents < COMMAND_OUTPUT_QUEUE_EVENTS && queued + event.chunk.length <= capacity) {
        queued += event.chunk.length;
        queuedEvents++;
        yield* Queue.offer(queue, event);
        return true;
      }
      yield* Deferred.await(wake);
    }
  });
  return {
    queued: () => queued,
    /** Offers the delta once it fits; false when it was dropped because its turn stopped. */
    offer: (
      queue: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>,
      input: CommandOutputDelta,
      stopped: () => boolean,
    ) =>
      offer(
        queue,
        input.chunk.length <= capacity
          ? input
          : { ...input, chunk: copyOutputTail(input.chunk, capacity) },
        stopped,
      ),
    /** Takes the next event for the reader, freeing the room a delta held. */
    take: (queue: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>) =>
      Queue.take(queue).pipe(
        Effect.tap((event) =>
          Effect.suspend(() => {
            if (event.type !== "command_output.delta") return Effect.void;
            queued -= event.chunk.length;
            queuedEvents--;
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
