import * as HostProcess from "@goat/shared/HostProcess";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ProcessRunner from "../processRunner.ts";
import { BOOT_SERVICE_NAMES, LEGACY_BOOT_SERVICE_NAMES } from "./bootServiceNames.ts";
import { defaultSystemdUnitDirectory, readSystemdUnitDirectory } from "./systemdUnitDirectory.ts";

export const bootServiceUnitPaths = Effect.fn("cloud.boot_service.unit_paths")(function* () {
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  if (home === "" && platform === "darwin") return undefined;
  if (platform === "darwin")
    return [BOOT_SERVICE_NAMES, LEGACY_BOOT_SERVICE_NAMES].map((names) =>
      path.join(home, "Library", "LaunchAgents", `${names.launchdLabel}.plist`),
    );
  if (platform !== "linux") return [];
  const fs = yield* FileSystem.FileSystem;
  const systemd = yield* fs.stat("/run/systemd/system").pipe(
    Effect.as(true),
    Effect.catch((error) => Effect.succeed(error.reason._tag === "NotFound" ? false : undefined)),
  );
  if (systemd === false) {
    const homeDir = yield* Config.String("HOME").pipe(Config.withDefault(""));
    if (homeDir === "") return undefined;
    const xdgConfigHome = yield* Config.String("XDG_CONFIG_HOME").pipe(Config.withDefault(""));
    const unitDir = defaultSystemdUnitDirectory(path, homeDir, xdgConfigHome);
    return [BOOT_SERVICE_NAMES, LEGACY_BOOT_SERVICE_NAMES].map((names) =>
      path.join(unitDir, names.unitFile),
    );
  }
  if (systemd === undefined) return undefined;
  const uid = yield* HostProcess.UserId;
  const runtimeDir = yield* Config.String("XDG_RUNTIME_DIR").pipe(Config.withDefault(""));
  const sudoUser = yield* Config.String("SUDO_USER").pipe(Config.withDefault(""));
  const runner = yield* ProcessRunner.ProcessRunner;
  const fallback =
    runtimeDir === "" && uid !== undefined && !(uid === 0 && sudoUser !== "")
      ? { XDG_RUNTIME_DIR: `/run/user/${uid}` }
      : undefined;
  const unitDir = yield* readSystemdUnitDirectory().pipe(
    Effect.provideService(
      ProcessRunner.ProcessRunner,
      fallback === undefined
        ? runner
        : {
            run: (request) => runner.run({ ...request, env: { ...fallback, ...request.env } }),
          },
    ),
  );
  if (unitDir === undefined) return undefined;
  return [BOOT_SERVICE_NAMES, LEGACY_BOOT_SERVICE_NAMES].map((names) =>
    path.join(unitDir, names.unitFile),
  );
});
