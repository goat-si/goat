import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { awaitQuiet } from "@goat/shared/stallAwareQuiet";
import * as Effect from "effect/Effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import type * as Scope from "effect/Scope";

const drainIo = Effect.callback<void>((resume) => {
  const id = setImmediate(() => resume(Effect.void));
  return Effect.sync(() => clearImmediate(id));
});

export const withWebSocketIdleTimeout = Effect.fn("WebSocket.withIdleTimeout")(function* (
  httpEffect: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    Scope.Scope | HttpServerRequest.HttpServerRequest
  >,
  drain: Effect.Effect<void> = drainIo,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const transport = NodeHttpServerRequest.toIncomingMessage(request).socket;
  let generation = 0;
  const onData = () => {
    generation += 1;
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => transport.on("data", onData)),
    () => Effect.sync(() => transport.off("data", onData)),
  );
  const idle = awaitQuiet({ windowMs: 300_000, activity: () => generation, drainIo: drain }).pipe(
    Effect.andThen(
      Effect.logInfo(
        "Closing idle RPC WebSocket after 300 seconds without inbound traffic, pongs included",
      ),
    ),
    Effect.andThen(Effect.sync(() => transport.destroy())),
    Effect.as(HttpServerResponse.empty()),
  );
  return yield* Effect.raceFirst(httpEffect, idle);
});
