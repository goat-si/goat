import { expect, it } from "@effect/vitest";
import type { ComputerUseReadiness, CuaDriverMcpConfiguration } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import * as CuaDriver from "./CuaDriver.ts";

const readiness: ComputerUseReadiness = {
  grants: { accessibility: "granted", screenCapture: "granted" },
  helper: "authenticated",
  capture: "ready",
  tree: "ready",
  input: "background",
  blockers: [],
  reasons: [],
};
const fixture = Effect.fn("CuaReadiness.test.fixture")(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const changes = yield* PubSub.unbounded<AwaitedSettings>();
  return {
    ...settings,
    subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
    updateSettings: (patch: Parameters<typeof settings.updateSettings>[0]) =>
      settings.updateSettings(patch).pipe(Effect.tap((next) => PubSub.publish(changes, next))),
  };
});
type AwaitedSettings = import("@goat/contracts").ServerSettings;
const mcp: CuaDriverMcpConfiguration = { command: "/driver", args: [], environment: [] };

it.effect(
  "reports helper readiness only while its driver runs, and decides tools from the server setting",
  () =>
    Effect.gen(function* () {
      const settings = yield* fixture();
      const stopped = yield* Deferred.make<void>();
      const service = yield* CuaDriver.make(
        () =>
          Effect.succeed({
            start: Effect.succeed(mcp),
            stop: Deferred.succeed(stopped, undefined).pipe(Effect.asVoid),
            waitForExit: Effect.never,
          }),
        Effect.succeed({ capability: "available", reason: "Desktop ready.", environment: [] }),
        {
          observeReadiness: () => Effect.succeed(readiness),
        },
      ).pipe(Effect.provideService(ServerSettings.ServerSettingsService, settings));
      expect(yield* service.status).toMatchObject({ tools: "off", running: false });
      expect((yield* service.status).readiness).toBeUndefined();
      yield* settings.updateSettings({ enableCua: true });
      expect(yield* service.status).toMatchObject({ tools: "unavailable", running: false });
      yield* service.acquire;
      expect(yield* service.status).toMatchObject({ tools: "available", running: true, readiness });
      yield* settings.updateSettings({ enableCua: false });
      yield* Deferred.await(stopped);
      expect(yield* service.status).toMatchObject({ tools: "off", running: false });
      expect((yield* service.status).readiness).toBeUndefined();
    }).pipe(
      Effect.provide(ServerSettings.layerTest()),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.scoped,
    ),
);

it.effect("discards a helper answer from a driver retired while status was being read", () =>
  Effect.gen(function* () {
    const settings = yield* fixture();
    yield* settings.updateSettings({ enableCua: true });
    const requested = yield* Deferred.make<void>();
    const answer = yield* Deferred.make<ComputerUseReadiness>();
    const stopped = yield* Deferred.make<void>();
    const service = yield* CuaDriver.make(
      () =>
        Effect.succeed({
          start: Effect.succeed(mcp),
          stop: Deferred.succeed(stopped, undefined).pipe(Effect.asVoid),
          waitForExit: Effect.never,
        }),
      Effect.succeed({ capability: "available", reason: "Desktop ready.", environment: [] }),
      {
        observeReadiness: () =>
          Deferred.succeed(requested, undefined).pipe(Effect.andThen(Deferred.await(answer))),
      },
    ).pipe(Effect.provideService(ServerSettings.ServerSettingsService, settings));
    yield* service.acquire;
    const status = yield* service.status.pipe(Effect.forkChild);
    yield* Deferred.await(requested);
    yield* settings.updateSettings({ enableCua: false });
    yield* Deferred.await(stopped);
    yield* Deferred.succeed(answer, readiness);
    const reported = yield* Fiber.join(status);
    expect(reported).toMatchObject({ tools: "off", running: false });
    expect(reported.readiness).toBeUndefined();
    expect((yield* service.status).readiness).toBeUndefined();
  }).pipe(
    Effect.provide(ServerSettings.layerTest()),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.scoped,
  ),
);
