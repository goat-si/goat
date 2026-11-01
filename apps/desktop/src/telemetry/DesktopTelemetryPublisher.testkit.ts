import { DesktopHostTelemetryMessage } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export const collectTelemetry = Effect.fn(function* (stream: Stream.Stream<Uint8Array>) {
  const messages = yield* Queue.unbounded<DesktopHostTelemetryMessage>();
  const received: DesktopHostTelemetryMessage[] = [];
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(DesktopHostTelemetryMessage));
  const fiber = yield* stream.pipe(
    Stream.mapEffect((bytes) => decode(new TextDecoder().decode(bytes).trim())),
    Stream.runForEach((message) => {
      received.push(message);
      return Queue.offer(messages, message);
    }),
    Effect.forkScoped,
  );
  const next = Effect.fn(function* (type: DesktopHostTelemetryMessage["type"]) {
    let message = yield* Queue.take(messages);
    while (message.type !== type) message = yield* Queue.take(messages);
    return message;
  });
  yield* next("desktopTelemetryHello");
  yield* next("desktopTelemetry");
  return { fiber, received, next };
});
