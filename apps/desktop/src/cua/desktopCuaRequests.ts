import type { DesktopCuaDriverRequest } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * Handles requests one at a time, in order, but calls onStop as a Stop arrives: a Stop must be
 * able to end a start still pending instead of queueing behind it until that start gives up.
 * The Stop request itself is handled in its turn and reports how the stop ended.
 */
export const handleStopFirst = <E, R>(
  requests: Stream.Stream<DesktopCuaDriverRequest>,
  handle: (request: DesktopCuaDriverRequest) => Effect.Effect<void, E, R>,
  onStop: () => void,
) =>
  requests.pipe(
    Stream.tap((request) => (request.enabled ? Effect.void : Effect.sync(onStop))),
    Stream.buffer({ capacity: "unbounded" }),
    Stream.runForEach(handle),
  );
