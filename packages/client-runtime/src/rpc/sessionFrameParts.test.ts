import { expect, it } from "@effect/vitest";
import { splitSocketFrame } from "@goat/shared/socketFrameParts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { PREPARED, SERVER_CONFIG } from "./sessionTestFixtures.ts";
import {
  makeFactory,
  awaitSocket,
  awaitRequest,
  encodeJson,
  encodeServerConfig,
} from "./sessionTestHarness.ts";

it.effect("connects while a large config snapshot downloads at 4000 bytes per second", () =>
  Effect.gen(function* () {
    const { factory, sockets } = yield* makeFactory();
    const session = yield* factory.connect(PREPARED);
    const readyFiber = yield* Effect.forkChild(session.ready);
    const socket = yield* awaitSocket(sockets);
    socket.open();
    const request = yield* awaitRequest(socket);
    // Multi-byte text, so parts must be sized in UTF-8 bytes and never split a surrogate pair.
    const config = { ...SERVER_CONFIG, cwd: "/" + "é€😀x".repeat(32 * 1024) };
    const frame = encodeJson({
      _tag: "Chunk",
      requestId: request.id,
      values: [{ version: 1, type: "snapshot", config: encodeServerConfig(config) }],
    });
    const parts = new URL(socket.url).searchParams.has("frameParts")
      ? splitSocketFrame(frame)
      : [frame];
    expect(parts.length).toBeGreaterThan(1);

    for (const part of parts) {
      const bytes = new TextEncoder().encode(part);
      yield* TestClock.adjust((bytes.length / 4000) * 1000);
      socket.serverMessage(new TextDecoder().decode(bytes));
    }
    yield* Fiber.join(readyFiber);

    expect(yield* session.initialConfig).toEqual(config);
  }),
);
