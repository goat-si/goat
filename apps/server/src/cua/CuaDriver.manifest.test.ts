import * as HostProcess from "@goat/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import { cuaDriverCapabilityManifest } from "@goat/shared/cuaDriverManifest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import * as CuaDriver from "./CuaDriver.ts";
import { refreshManifest } from "./StandaloneCuaManifest.ts";

it.layer(ServerSettings.layerTest({ enableCua: true }))("standalone manifest refresh", (it) => {
  it.effect.each([
    {
      name: "rewrites a missing approved app and retires exactly one driver",
      before: ["host"],
      after: ["host", "editor"],
      running: true,
      prepares: 1,
      stops: 1,
    },
    {
      name: "does not prepare or restart for an app already listed",
      before: ["host", "editor"],
      after: ["host", "editor"],
      running: true,
      prepares: 0,
      stops: 0,
    },
    {
      name: "does not restart when a re-listing still misses the approved app",
      before: ["host"],
      after: ["host"],
      running: true,
      prepares: 1,
      stops: 0,
    },
    {
      name: "does nothing when the driver is not running",
      before: ["host"],
      after: ["host", "editor"],
      running: false,
      prepares: 0,
      stops: 0,
    },
  ])("$name", (scenario) =>
    Effect.gen(function* () {
      let text = cuaDriverCapabilityManifest({ applications: scenario.before });
      let prepares = 0;
      let reads = 0;
      let stops = 0;
      let starts = 0;
      const listedOn: Array<ReadonlyArray<{ readonly name: string; readonly value: string }>> = [];
      const exited = yield* Deferred.make<void>();
      const service = yield* CuaDriver.make(
        () =>
          Effect.succeed({
            start: Effect.sync(() => {
              starts++;
              return { command: "/driver", args: [], environment: [] };
            }),
            stop: Effect.sync(() => {
              stops++;
            }),
            waitForExit: Deferred.await(exited),
          }),
        Effect.succeed({
          capability: "available",
          reason: "test display",
          environment: [{ name: "DISPLAY", value: ":1" }],
        }),
        {
          refreshManifest: (apps, display) =>
            refreshManifest({
              apps,
              path: "/manifest",
              read: () =>
                Effect.sync(() => {
                  reads++;
                  return text;
                }),
              prepare: Effect.sync(() => {
                prepares++;
                listedOn.push(display);
                text = cuaDriverCapabilityManifest({ applications: scenario.after });
                return "/manifest";
              }),
              restore: (previous) =>
                Effect.sync(() => {
                  text = previous;
                }),
            }).pipe(
              Effect.mapError(
                (cause) => new CuaDriver.CuaDriverHostError({ operation: "restart", cause }),
              ),
            ),
        },
      );
      if (scenario.running) expect(Option.isSome(yield* service.acquire)).toBe(true);
      yield* service.refreshManifest!(["editor"]);
      if (scenario.prepares === 0 || scenario.stops > 0)
        yield* service.refreshManifest!(["editor"]);
      expect(prepares).toBe(scenario.prepares);
      // A server started without DISPLAY lists windows only on the screen its driver runs on.
      for (const display of listedOn) expect(display).toEqual([{ name: "DISPLAY", value: ":1" }]);
      expect(stops).toBe(scenario.stops);
      expect(starts).toBe(scenario.running ? 1 : 0);
      if (!scenario.running) expect(reads).toBe(0);
      if (scenario.stops) {
        expect(text).toBe(cuaDriverCapabilityManifest({ applications: scenario.after }));
        expect(yield* service.lastFailure).toEqual(Option.none());
        yield* service.acquire;
        expect(starts).toBe(2);
      }
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, {}),
    ),
  );

  it.effect(
    "a refresh that keeps the driver restores its manifest, so a later approval of an app found meanwhile restarts it",
    () =>
      Effect.gen(function* () {
        const running = cuaDriverCapabilityManifest({ applications: ["host"] });
        let disk = running;
        let stops = 0;
        const exited = yield* Deferred.make<void>();
        const service = yield* CuaDriver.make(
          () =>
            Effect.succeed({
              start: Effect.succeed({ command: "/driver", args: [], environment: [] }),
              stop: Effect.sync(() => {
                stops++;
              }),
              waitForExit: Deferred.await(exited),
            }),
          Effect.succeed({ capability: "available", reason: "test display", environment: [] }),
          {
            refreshManifest: (apps) =>
              refreshManifest({
                apps,
                path: "/manifest",
                read: () => Effect.sync(() => disk),
                prepare: Effect.sync(() => {
                  disk = cuaDriverCapabilityManifest({ applications: ["host", "browser"] });
                  return "/manifest";
                }),
                restore: (text) =>
                  Effect.sync(() => {
                    disk = text;
                  }),
              }).pipe(
                Effect.mapError(
                  (cause) => new CuaDriver.CuaDriverHostError({ operation: "restart", cause }),
                ),
              ),
          },
        );
        expect(Option.isSome(yield* service.acquire)).toBe(true);
        yield* service.refreshManifest!(["editor"]);
        expect(stops).toBe(0);
        expect(disk).toBe(running);
        yield* service.refreshManifest!(["browser"]);
        expect(stops).toBe(1);
      }).pipe(
        Effect.scoped,
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, {}),
      ),
  );
});

it.layer(ServerSettings.layerTest({ enableCua: true }))("browser manifest publication", (it) => {
  it.effect("publishes through the running driver without restarting it", () =>
    Effect.gen(function* () {
      let stopped = 0;
      const exited = yield* Deferred.make<void>();
      const expected = "a".repeat(64);
      const service = yield* CuaDriver.make(
        () =>
          Effect.succeed({
            start: Effect.succeed({ command: "/driver", args: [], environment: [] }),
            stop: Effect.sync(() => {
              stopped++;
            }),
            waitForExit: Deferred.await(exited),
          }),
        Effect.succeed({ capability: "available", reason: "test", environment: [] }),
        { publishBrowserManifest: () => Effect.succeed(expected) },
      );
      yield* service.acquire;
      if (!service.publishBrowserManifest) return expect.fail("publisher unavailable");
      const sha = yield* service.publishBrowserManifest({
        existingProfiles: [{ pid: 12, windowId: 34 }],
        origins: ["https://example.test"],
      });
      expect(sha).toBe(expected);
      expect(stopped).toBe(0);
    }).pipe(Effect.scoped),
  );
});
