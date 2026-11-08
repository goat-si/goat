import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/http";
import * as Layer from "effect/Layer";
import * as NetAddress from "effect/net/NetAddress";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { layerTailscaleServeStartup, type TailscaleServeTarget } from "./TailscaleServeStartup.ts";

const httpServer = (address: NetAddress.SocketAddress) =>
  Layer.succeed(
    HttpServer.HttpServer,
    HttpServer.HttpServer.of({
      address,
      serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
    }),
  );

it.effect("re-applies the saved port after a failed start", () =>
  Effect.gen(function* () {
    const calls = yield* Queue.unbounded<number>();
    const failuresLeft = yield* Ref.make(1);
    const parked = yield* Deferred.make<void>();
    const ensure = Effect.fn("TailscaleServeStartup.test.ensure")(function* (
      target: TailscaleServeTarget,
    ) {
      yield* Queue.offer(calls, target.servePort);
      const left = yield* Ref.getAndUpdate(failuresLeft, (count) => (count > 0 ? count - 1 : 0));
      if (left > 0) return yield* Effect.fail("tailscaled not ready");
    });
    const layer = layerTailscaleServeStartup({
      enabled: true,
      servePort: 47743,
      parked,
      awaitActivation: Effect.void,
      ensure,
      disable: () => Effect.void,
    }).pipe(Layer.provide(httpServer(NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773))));

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(layer);
        expect(yield* Queue.take(calls)).toBe(47743);
        yield* TestClock.adjust(Duration.seconds(3));
        expect(yield* Queue.take(calls)).toBe(47743);
      }),
    );
  }),
);
