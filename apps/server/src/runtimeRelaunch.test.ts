import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { pinnedRuntimePaths } from "./cloud/pinnedRuntime.ts";
import { SERVICE_LAUNCHER_CONTEXT_ENV } from "./cloud/serviceProtocol.ts";
import * as ServerConfig from "./config.ts";
import * as RuntimeRelaunch from "./runtimeRelaunch.ts";

const serve = ["C:\\goat\\goat.exe", "C:\\goat\\goat.exe", "serve", "--port", "3773"];

const prepare = (input: {
  readonly platform?: NodeJS.Platform;
  readonly mode?: "web" | "desktop";
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: ReadonlyArray<string>;
  readonly installed?: boolean;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-relaunch-" });
    const platform = input.platform ?? "win32";
    if (input.installed !== false) {
      const paths = pinnedRuntimePaths(path, baseDir, "2.0.0", platform);
      yield* fs.makeDirectory(paths.versionDir, { recursive: true });
      yield* fs.writeFileString(paths.sentinelPath, "2.0.0\n");
    }
    const config = yield* ServerConfig.ServerConfig.pipe(
      Effect.provide(ServerConfig.ServerConfig.layerTest(baseDir, baseDir)),
    );
    const started: RuntimeRelaunch.RelaunchCommand[] = [];
    const relaunch = yield* RuntimeRelaunch.make((command) =>
      Effect.sync(() => {
        started.push(command);
      }),
    ).pipe(
      Effect.provideService(ServerConfig.ServerConfig, { ...config, mode: input.mode ?? "web" }),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provideService(HostProcess.Environment, input.env ?? { GOAT_OTLP_HEADERS: "a=b%20c" }),
      Effect.provideService(HostProcess.WorkingDirectory, "C:\\work"),
      Effect.provideService(HostProcess.Arguments, input.argv ?? serve),
    );
    const decision = yield* relaunch.prepare("2.0.0");
    if (decision._tag === "ready") yield* decision.start;
    return {
      decision,
      started,
      entry: pinnedRuntimePaths(path, baseDir, "2.0.0", platform).entryPath,
    };
  });

it.layer(NodeServices.layer)("RuntimeRelaunch", (it) => {
  it.effect(
    "starts the installed target with this server's own arguments, folder and environment",
    () =>
      Effect.gen(function* () {
        const { decision, started, entry } = yield* prepare({});
        assert.equal(decision._tag, "ready");
        assert.deepEqual(started, [
          {
            command: entry,
            args: ["serve", "--port", "3773"],
            cwd: "C:\\work",
            env: { GOAT_OTLP_HEADERS: "a=b%20c" },
          },
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect("refuses servers it cannot start again the same way", () =>
    Effect.gen(function* () {
      const cases = [
        { platform: "linux" as const },
        { mode: "desktop" as const },
        { env: { [SERVICE_LAUNCHER_CONTEXT_ENV]: "{}" } },
        { env: { GOAT_BOOTSTRAP_FD: "3" } },
        { argv: [...serve, "--bootstrap-fd", "3"] },
        { installed: false },
      ];
      for (const input of cases) {
        const { decision, started } = yield* prepare(input);
        assert.equal(decision._tag, "unavailable", JSON.stringify(input));
        assert.deepEqual(started, []);
      }
    }).pipe(Effect.scoped),
  );
});
