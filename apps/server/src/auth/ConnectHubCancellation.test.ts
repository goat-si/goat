import { expect, it } from "@effect/vitest";
import { ServerSettings } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Config from "../config.ts";
import * as Runtime from "./ConnectHubRuntime.testkit.ts";
import { admits } from "./HubConnectAccess.ts";

const decodeSettings = Schema.decodeEffect(Schema.fromJsonString(ServerSettings));

it.effect.each([true, false])(
  "cancellation after durable consent=%s commit still publishes settings and policy",
  (allowed) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* Config.ServerConfig;
      const committed = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const interruptRequested = yield* Deferred.make<void>();
      const watch = yield* Runtime.watcher;
      let armed = false;
      const runtime = yield* Runtime.open({
        fs: {
          ...watch.fs,
          rename: (from, to) =>
            fs
              .rename(from, to)
              .pipe(
                Effect.tap(() =>
                  armed && to === config.settingsPath
                    ? Deferred.succeed(committed, undefined).pipe(
                        Effect.andThen(Deferred.await(release)),
                      )
                    : Effect.void,
                ),
              ),
        },
      });
      yield* runtime.settings.start;
      yield* runtime.settings.updateSettings({
        hub: { enabled: true, connectDevicesHubProxy: !allowed },
      });
      const old = yield* runtime.sessions
        .issue({
          subject: "cloud-connect",
          scopes: ["hub:proxy"],
          connectAccessGeneration: (yield* runtime.access.current).generation,
        })
        .pipe(Effect.flatMap((issued) => runtime.sessions.verify(issued.token)));
      const changes = yield* runtime.settings.subscribeChanges;
      armed = true;
      const writer = yield* runtime.settings
        .updateSettings({ hub: { connectDevicesHubProxy: allowed } })
        .pipe(Effect.forkScoped);
      const interruption = yield* Effect.gen(function* () {
        yield* Deferred.await(committed);
        const persisted = yield* decodeSettings(yield* fs.readFileString(config.settingsPath));
        expect(persisted.hub.connectDevicesHubProxy).toBe(allowed);
        const interruption = yield* Deferred.succeed(interruptRequested, undefined).pipe(
          Effect.andThen(Fiber.interrupt(writer)),
          Effect.forkScoped,
        );
        yield* Deferred.await(interruptRequested);
        return interruption;
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      yield* Fiber.join(interruption);
      expect(yield* changes.pipe(Stream.runHead)).toMatchObject({
        value: { hub: { connectDevicesHubProxy: allowed } },
      });
      expect((yield* runtime.settings.getSettings).hub.connectDevicesHubProxy).toBe(allowed);
      const state = yield* runtime.access.current;
      expect(state.allowed).toBe(allowed);
      expect(yield* runtime.sessions.verify(old.token).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
      });
      const grant = yield* runtime.auth.createCloudConnectPairingLink({
        proofKeyThumbprint: "new-key",
      });
      expect(grant.scopes.includes("hub:proxy")).toBe(allowed);
    }).pipe(Effect.scoped, Effect.provide(Runtime.storage)),
);

it.effect(
  "closing the recovery scope stops acknowledged retries; a new scope recovers the durable fence",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* Config.ServerConfig;
      const sql = yield* SqlClient.SqlClient;
      const attempts = yield* Queue.unbounded<void>();
      let fault = false;
      const watch = yield* Runtime.watcher;
      const runtime = yield* Runtime.open({
        fs: {
          ...watch.fs,
          remove: (file, options) =>
            fault && file.endsWith("connect-hub-access.fence")
              ? Queue.offer(attempts, undefined).pipe(
                  Effect.andThen(
                    Effect.fail(
                      PlatformError.systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "remove",
                        pathOrDescriptor: file,
                      }),
                    ),
                  ),
                )
              : fs.remove(file, options),
        },
      });
      yield* runtime.settings.start;
      yield* runtime.settings.updateSettings({
        hub: { enabled: true, connectDevicesHubProxy: true },
      });
      const old = yield* runtime.sessions
        .issue({
          subject: "cloud-connect",
          scopes: ["hub:proxy"],
          connectAccessGeneration: (yield* runtime.access.current).generation,
        })
        .pipe(Effect.flatMap((issued) => runtime.sessions.verify(issued.token)));
      fault = true;
      expect(
        yield* runtime.settings
          .updateSettings({ hub: { connectDevicesHubProxy: false } })
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
      yield* Queue.take(attempts);
      yield* Queue.take(attempts);
      yield* runtime.close;
      const before = yield* sql`SELECT generation FROM hub_connect_access WHERE id = 1`;
      fault = false;
      yield* TestClock.adjust("1 minute");
      expect(yield* sql`SELECT generation FROM hub_connect_access WHERE id = 1`).toEqual(before);
      expect(yield* fs.exists(`${config.stateDir}/connect-hub-access.fence`)).toBe(true);
      const nextWatch = yield* Runtime.watcher;
      const next = yield* Runtime.open({ fs: nextWatch.fs });
      yield* next.settings.start;
      yield* next.settings.ready;
      expect(yield* next.access.current).toMatchObject({ allowed: true, fenced: false });
      expect(admits(old, yield* next.access.current)).toBe(false);
      expect(yield* fs.exists(`${config.stateDir}/connect-hub-access.fence`)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(Runtime.storage)),
);
