import { ServerConfig } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { PREPARED } from "./sessionTestFixtures.ts";
import { toServerClock } from "../clock.ts";
import * as Schema from "effect/Schema";
import {
  ENCODED_SERVER_CONFIG,
  makeFactory,
  awaitSocket,
  completeInitialConfig,
} from "./sessionTestHarness.ts";

const decodeServerConfig = Schema.decodeSync(ServerConfig);

it("accepts malformed optional server clock samples without rejecting the server config", () => {
  const input = { ...ENCODED_SERVER_CONFIG, serverTime: { malformed: true } };
  const decoded = decodeServerConfig(input);
  expect(decoded.serverTime).toEqual({ malformed: true });
});

it("clears invalid clock samples and rejects older connection samples", async () => {
  const { EnvironmentId } = await import("@goat/contracts");
  const { beginServerClockSample, recordServerClockSample, toServerClock } =
    await import("../clock.ts");
  const id = EnvironmentId.make("clock-test");
  const first = beginServerClockSample(id);
  recordServerClockSample(id, first, "2026-01-01T01:00:00.000Z", 0, 0);
  expect(toServerClock(id, 1_000)).toBe(Date.parse("2026-01-01T01:00:01.000Z"));
  const next = beginServerClockSample(id);
  recordServerClockSample(id, next, { malformed: true }, 0, 0);
  recordServerClockSample(id, first, "2026-01-01T01:00:00.000Z", 0, 0);
  expect(toServerClock(id, 1_000)).toBe(1_000);
});

it.effect("connects successfully when the welcome clock sample is malformed", () =>
  Effect.gen(function* () {
    const { factory, sockets } = yield* makeFactory();
    const session = yield* factory.connect(PREPARED);
    const ready = yield* Effect.forkChild(session.ready);
    const socket = yield* awaitSocket(sockets);
    socket.open();
    yield* completeInitialConfig(socket, {
      ...ENCODED_SERVER_CONFIG,
      serverTime: { malformed: true },
    });
    yield* Fiber.join(ready);
    expect(toServerClock(PREPARED.environmentId, 1000)).toBe(1000);
  }),
);
