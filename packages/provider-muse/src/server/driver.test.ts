import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderLatestVersions from "@goat/provider-core/server/ProviderLatestVersions";
import * as ProviderEventLoggers from "@goat/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HttpClient from "effect/http/HttpClient";
import { MuseDriver } from "./driver.ts";

it.effect(
  "refreshes the host PATH while preserving instance overrides and dropping host credentials",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "muse-driver-home-" });
      const host = { HOME: home, PATH: "/usr/bin:/bin", META_API_KEY: "secret" };
      const launches: NodeJS.ProcessEnv[] = [];
      const spawner = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command)) launches.push(command.options.env ?? {});
        return Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            cause: { code: "ENOENT" },
          }),
        );
      });
      const create = (environment: Array<{ name: string; value: string; sensitive: boolean }>) =>
        MuseDriver.create({
          instanceId: ProviderInstanceId.make("muse-test"),
          displayName: undefined,
          environment,
          enabled: true,
          config: MuseDriver.defaultConfig(),
        });
      const inherited = yield* create([]).pipe(
        Effect.provideService(HostProcess.Environment, host),
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const overridden = yield* create([{ name: "PATH", value: host.PATH, sensitive: false }]).pipe(
        Effect.provideService(HostProcess.Environment, host),
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      yield* inherited.snapshot.refresh;
      yield* overridden.snapshot.refresh;
      launches.length = 0;
      host.PATH = "/new/bin:/usr/bin:/bin";
      yield* inherited.snapshot.refresh;
      expect(launches.length).toBeGreaterThan(0);
      expect(launches.every((env) => env.PATH === host.PATH)).toBe(true);
      launches.length = 0;
      yield* overridden.snapshot.refresh;
      expect(launches.length).toBeGreaterThan(0);
      expect(launches.every((env) => env.PATH === "/usr/bin:/bin")).toBe(true);
      expect(launches.every((env) => !("META_API_KEY" in env))).toBe(true);
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.Environment, { PATH: "/unused" }),
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          ProviderLatestVersions.layer,
          TestProviderHost.layer({
            settings: { ...DEFAULT_SERVER_SETTINGS, enableProviderUpdateChecks: false },
            runBackgroundWork: false,
          }),
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Unexpected HTTP")),
          ),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
);
