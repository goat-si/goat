import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import type * as Scope from "effect/Scope";

// Hidden tabs can throttle heartbeats to minute-aligned wakeups.
const IDLE_TIMEOUT_MS = 120_000;

export const withWebSocketIdleTimeout = Effect.fnUntraced(function* (
  httpEffect: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    Scope.Scope | HttpServerRequest.HttpServerRequest
  >,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const clock = yield* Clock.Clock;
  const transport = NodeHttpServerRequest.toIncomingMessage(request).socket;
  let lastReceived = clock.monotonicTimeNanosUnsafe();
  // Observe the transport so control frames and fragmented messages also count,
  // independently of RPC decoding, stream output, or handler execution.
  const onData = () => {
    lastReceived = clock.monotonicTimeNanosUnsafe();
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => transport.on("data", onData)),
    () => Effect.sync(() => transport.off("data", onData)),
  );
  const idle = Effect.gen(function* () {
    let remaining = IDLE_TIMEOUT_MS;
    while (remaining > 0) {
      yield* Effect.sleep(remaining);
      remaining =
        IDLE_TIMEOUT_MS - Number(clock.monotonicTimeNanosUnsafe() - lastReceived) / 1_000_000;
    }
    yield* Effect.logInfo("Closing idle RPC WebSocket after 120 seconds without inbound traffic");
    // A vanished peer cannot complete a WebSocket close handshake.
    yield* Effect.sync(() => transport.destroy());
    return HttpServerResponse.empty();
  });
  return yield* Effect.raceFirst(httpEffect, idle);
});
