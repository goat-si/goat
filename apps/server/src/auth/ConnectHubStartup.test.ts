import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Config from "../config.ts";
import * as Runtime from "./ConnectHubRuntime.testkit.ts";

const request = (token: string) =>
  HttpServerRequest.fromWeb(
    new Request("http://hub.test/api/auth/session", {
      headers: { authorization: `Bearer ${token}` },
    }),
  );

it.effect(
  "fenced startup waits in its owning scope, reconciles edits during recovery, and observes later file events",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* Config.ServerConfig;
      const watch = yield* Runtime.watcher;
      const first = yield* Runtime.open({ fs: watch.fs });
      yield* first.auth.setCloudLinkTrust("test-account");
      yield* first.settings.start;
      yield* first.settings.updateSettings({
        hub: { enabled: true, connectDevicesHubProxy: true },
      });
      const token = yield* first.sessions.issue({
        subject: "cloud-connect",
        method: "bearer-access-token",
        scopes: ["hub:proxy"],
        connectAccessGeneration: (yield* first.access.current).generation,
      });
      yield* first.auth.authenticateHttpRequest(request(token.token));
      yield* sql`CREATE TRIGGER fail_connect_bump BEFORE UPDATE ON hub_connect_access BEGIN SELECT RAISE(FAIL, 'injected startup write failure'); END`;
      yield* first.settings
        .updateSettings({ hub: { connectDevicesHubProxy: false } })
        .pipe(Effect.result);
      yield* first.close;
      const waiting = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      const secondWatch = yield* Runtime.watcher;
      const second = yield* Runtime.open({
        fs: secondWatch.fs,
        access: (service) => ({
          ...service,
          awaitRecovery: Deferred.succeed(waiting, undefined).pipe(
            Effect.andThen(service.awaitRecovery),
          ),
        }),
      });
      const startup = yield* second.settings.start.pipe(
        Effect.andThen(Deferred.succeed(ready, undefined)),
        Effect.forkScoped,
      );
      yield* Deferred.await(waiting);
      yield* secondWatch.installed;
      expect(yield* Deferred.isDone(ready)).toBe(false);
      expect(yield* second.access.current).toMatchObject({ allowed: false, fenced: true });
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({
          hub: { enabled: true, connectDevicesHubProxy: true },
          worktreesDirectory: "/edited-during-recovery",
        }),
      );
      yield* secondWatch.notify(config.settingsPath);
      yield* TestClock.adjust(100);
      expect(yield* Deferred.isDone(ready)).toBe(false);
      yield* sql`DROP TRIGGER fail_connect_bump`;
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(startup);
      yield* second.settings.ready;
      expect((yield* second.settings.getSettings).worktreesDirectory).toBe(
        "/edited-during-recovery",
      );
      expect(yield* second.access.current).toMatchObject({ allowed: true, fenced: false });
      expect(
        yield* second.auth.authenticateHttpRequest(request(token.token)).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
      const changes = yield* second.settings.subscribeChanges;
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({ hub: { enabled: false, connectDevicesHubProxy: true } }),
      );
      yield* secondWatch.notify(config.settingsPath);
      yield* TestClock.adjust(100);
      const observed = yield* changes.pipe(Stream.runHead);
      expect(observed).toMatchObject({
        value: { hub: { enabled: false, connectDevicesHubProxy: true } },
      });
      expect((yield* second.access.current).allowed).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(Runtime.storage)),
);
