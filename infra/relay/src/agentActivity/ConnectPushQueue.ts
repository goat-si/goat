import { isGoatConnectPushEnabled } from "@goat/shared/goatConnect";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export const consume = Effect.fn("ConnectPushQueue.consume")(
  <A, E, R, E2, R2>(
    stream: Stream.Stream<A, E, R>,
    deliver: (message: A) => Effect.Effect<void, E2, R2>,
  ) => (isGoatConnectPushEnabled() ? Stream.runForEach(stream, deliver) : Stream.runDrain(stream)),
);
