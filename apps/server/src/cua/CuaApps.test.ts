import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import type { DesktopCuaAppsReport } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as CuaDriver from "./CuaDriver.ts";

const fixture = Effect.fnUntraced(function* (synchronous = false, failSend = false) {
  const reports = yield* PubSub.unbounded<DesktopCuaAppsReport>();
  const requests = yield* Queue.unbounded<string>();
  const listing = yield* CuaDriver.makeDesktopAppsListing().pipe(
    Effect.provide(
      DesktopTelemetryReceiver.layerTest({
        cuaApps: Stream.fromPubSub(reports),
        requestCuaApps: (requestId) =>
          Effect.gen(function* () {
            yield* Queue.offer(requests, requestId);
            if (failSend)
              return yield* new DesktopTelemetryReceiver.DesktopTelemetryDescriptorUnavailable({
                mode: "test",
              });
            if (synchronous)
              yield* PubSub.publish(reports, {
                version: 1,
                type: "cuaApps",
                requestId,
                status: "listed",
                apps: ["Editor"],
              });
          }),
      }),
    ),
    Effect.provide(NodeCrypto.layer),
  );
  return { listing, requests, reports };
});

it.effect("subscribes before requesting a fresh list, including synchronous desktop replies", () =>
  Effect.gen(function* () {
    const f = yield* fixture(true);
    expect(yield* f.listing).toEqual(Option.some(["Editor"]));
    const first = yield* Queue.take(f.requests);
    expect(yield* f.listing).toEqual(Option.some(["Editor"]));
    expect(yield* Queue.take(f.requests)).not.toBe(first);
  }).pipe(Effect.scoped),
);

it.effect("ignores another request's report and preserves the matching listing", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const pending = yield* f.listing.pipe(Effect.forkChild);
    const requestId = yield* Queue.take(f.requests);
    yield* PubSub.publish(f.reports, {
      version: 1,
      type: "cuaApps",
      requestId: "wrong-id",
      status: "listed",
      apps: ["Wrong"],
    });
    yield* PubSub.publish(f.reports, {
      version: 1,
      type: "cuaApps",
      requestId,
      status: "listed",
      apps: ["Correct"],
    });
    expect(yield* Fiber.join(pending)).toEqual(Option.some(["Correct"]));
  }).pipe(Effect.scoped),
);

it.effect("unavailable, failed send, and a silent old desktop all return no listing", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const pending = yield* f.listing.pipe(Effect.forkChild);
    const requestId = yield* Queue.take(f.requests);
    yield* PubSub.publish(f.reports, {
      version: 1,
      type: "cuaApps",
      requestId,
      status: "unavailable",
    });
    expect(yield* Fiber.join(pending)).toEqual(Option.none());
    const failed = yield* fixture(false, true);
    expect(yield* failed.listing).toEqual(Option.none());
    const timed = yield* f.listing.pipe(Effect.forkChild);
    yield* Queue.take(f.requests);
    yield* TestClock.adjust("10 seconds");
    expect(yield* Fiber.join(timed)).toEqual(Option.none());
  }).pipe(Effect.scoped),
);

it.effect(
  "disabled computer use never asks the desktop for apps, and standalone has no listing",
  () =>
    Effect.gen(function* () {
      const probe = Effect.succeed({
        capability: "unavailable" as const,
        reason: "No desktop",
        environment: [],
      });
      const disabled = yield* CuaDriver.make(() => Effect.die("unexpected start"), probe, {
        listedApps: Effect.die("disabled listing"),
      });
      expect(yield* disabled.listedApps).toEqual(Option.none());
      const standalone = yield* CuaDriver.make(() => Effect.die("unexpected start"), probe).pipe(
        Effect.provide(ServerSettings.layerTest({ enableCua: true })),
      );
      expect(yield* standalone.listedApps).toEqual(Option.none());
    }).pipe(Effect.provide(ServerSettings.layerTest({ enableCua: false })), Effect.scoped),
);
