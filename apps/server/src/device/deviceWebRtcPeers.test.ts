import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as WebRtcPeers from "./deviceWebRtcPeers.ts";

it.effect("retries a refused close of a revoked WebRTC peer until the helper accepts it", () =>
  Effect.gen(function* () {
    const peers = WebRtcPeers.make(yield* Effect.scope);
    let attempts = 0;
    const closed = yield* Deferred.make<void>();
    const closeUpstream = Effect.suspend(() => {
      attempts++;
      return attempts < 3 ? Effect.fail("refused" as const) : Deferred.succeed(closed, undefined);
    });
    expect(yield* peers.reserve("session")).toBe(true);
    yield* peers.opened("session", "peer", Effect.void, closeUpstream);
    yield* TestClock.adjust("1 second");
    yield* TestClock.adjust("2 seconds");
    yield* Deferred.await(closed);
    expect(attempts).toBe(3);
  }).pipe(Effect.scoped),
);
