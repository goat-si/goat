import { expect, it } from "@effect/vitest";
import { WS_METHODS } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { PREPARED } from "./sessionTestFixtures.ts";
import {
  makeFactory,
  awaitSocket,
  awaitRequest,
  completeInitialConfig,
} from "./sessionTestHarness.ts";

it.effect("ends a stream at once when its socket closes", () =>
  Effect.gen(function* () {
    const { factory, sockets } = yield* makeFactory();
    const session = yield* factory.connect(PREPARED);
    const readyFiber = yield* Effect.forkChild(session.ready);
    const socket = yield* awaitSocket(sockets);
    socket.open();
    yield* completeInitialConfig(socket);
    yield* Fiber.join(readyFiber);
    // Like the supervisor: the closed session interrupts its streams, and a
    // stream interrupt must not wait for a socket that is gone.
    const ended = yield* Effect.forkChild(
      Effect.raceFirst(
        Effect.flip(session.closed),
        session.client[WS_METHODS.subscribeServerLifecycle]({}).pipe(
          Stream.runDrain,
          Effect.andThen(Effect.never),
        ),
      ),
    );
    yield* awaitRequest(socket, 1);
    socket.close(1006);
    yield* TestClock.adjust("999 millis");

    expect(ended.pollUnsafe()).toBeDefined();
    // A request made after the close still fails instead of waiting forever.
    const lateProbe = yield* Effect.forkChild(session.probe);
    yield* TestClock.adjust("999 millis");
    expect(lateProbe.pollUnsafe()?._tag).toBe("Failure");
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);
