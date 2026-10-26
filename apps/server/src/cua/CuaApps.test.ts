import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import type { DesktopCuaAppsReport, DesktopCuaReadinessReport } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as CuaDriver from "./CuaDriver.ts";
import * as DesktopAppsListing from "./DesktopAppsListing.ts";

/** What a desktop that answers app listing requests says in its helper readiness (#1567). */
const readiness = (appsListing: boolean | undefined): DesktopCuaReadinessReport => ({
  version: 1,
  type: "cuaReadiness",
  generation: 1,
  readiness: {
    grants: { accessibility: "granted", screenCapture: "granted" },
    helper: "authenticated",
    capture: "ready",
    tree: "ready",
    input: "background",
    blockers: [],
    reasons: [],
  },
  signals: { humanInput: "unsupported", privateMode: "supported" },
  ...(appsListing === undefined ? {} : { appsListing }),
});

const fixture = Effect.fnUntraced(function* (
  synchronous = false,
  failSend = false,
  advertised: Option.Option<DesktopCuaReadinessReport> = Option.some(readiness(true)),
) {
  const reports = yield* PubSub.unbounded<DesktopCuaAppsReport>();
  const requests = yield* Queue.unbounded<string>();
  const request = yield* DesktopAppsListing.makeDesktopAppsRequest().pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        DesktopTelemetryReceiver.layerTest({
          cuaReadiness: Effect.succeed(advertised),
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
    ),
  );
  const listing = request.pipe(Effect.map(Option.map((listed) => listed.apps)));
  return { listing, request, requests, reports };
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

it.effect.each([
  ["a desktop that does not advertise listing", Option.some(readiness(undefined))],
  ["a desktop with listing turned off", Option.some(readiness(false))],
  ["a desktop that has not reported readiness", Option.none<DesktopCuaReadinessReport>()],
] as const)(
  "%s is not asked for apps, so an approval card does not wait for its deadline (#1567)",
  ([, advertised]) =>
    Effect.gen(function* () {
      const f = yield* fixture(false, false, advertised);
      // A millisecond of clock is enough: a listing that waited for the desktop is still pending.
      const pending = yield* f.listing.pipe(Effect.timeoutOption("1 millis"), Effect.forkChild);
      yield* TestClock.adjust("1 millis");
      expect(yield* Fiber.join(pending)).toEqual(Option.some(Option.none()));
      expect(yield* Queue.size(f.requests)).toBe(0);
    }).pipe(Effect.scoped),
);

it.effect(
  "passes on the desktop's names and icons, and an empty catalog from a desktop that sends none",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const named = yield* f.request.pipe(Effect.forkChild);
      const first = yield* Queue.take(f.requests);
      yield* PubSub.publish(f.reports, {
        version: 1,
        type: "cuaApps",
        requestId: first,
        status: "listed",
        apps: ["com.apple.finder"],
        catalog: [{ id: "com.apple.finder", name: "Finder", icon: "data:image/png;base64,AA==" }],
      });
      expect(yield* Fiber.join(named)).toEqual(
        Option.some({
          apps: ["com.apple.finder"],
          catalog: [{ id: "com.apple.finder", name: "Finder", icon: "data:image/png;base64,AA==" }],
        }),
      );
      const unnamed = yield* f.request.pipe(Effect.forkChild);
      const second = yield* Queue.take(f.requests);
      yield* PubSub.publish(f.reports, {
        version: 1,
        type: "cuaApps",
        requestId: second,
        status: "listed",
        apps: ["com.apple.finder"],
      });
      expect(yield* Fiber.join(unnamed)).toEqual(
        Option.some({ apps: ["com.apple.finder"], catalog: [] }),
      );
    }).pipe(Effect.scoped),
);

it("names an executable-path app by its file name", () => {
  expect(CuaDriver.catalogName("C:\\Apps\\Editor.exe")).toBe("Editor");
  expect(CuaDriver.catalogName("/usr/bin/gedit")).toBe("gedit");
  expect(CuaDriver.catalogName("com.apple.finder")).toBe("com.apple.finder");
});
