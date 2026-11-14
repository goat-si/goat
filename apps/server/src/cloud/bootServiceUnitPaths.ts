import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import {
  BOOT_SERVICE_NAMES,
  LEGACY_BOOT_SERVICE_NAMES,
  readSystemdUnitDirectory,
} from "./bootService.ts";

export const bootServiceUnitPaths = Effect.fn("cloud.boot_service.unit_paths")(function* () {
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  if (home === "") return [];
  if (platform === "darwin")
    return [BOOT_SERVICE_NAMES, LEGACY_BOOT_SERVICE_NAMES].map((names) =>
      path.join(home, "Library", "LaunchAgents", `${names.launchdLabel}.plist`),
    );
  if (platform !== "linux") return [];
  const environment = yield* HostProcess.Environment;
  const xdg = environment["XDG_CONFIG_HOME"] ?? "";
  const unitDir =
    (yield* readSystemdUnitDirectory()) ??
    path.join(path.isAbsolute(xdg) ? xdg : path.join(home, ".config"), "systemd", "user");
  return [BOOT_SERVICE_NAMES, LEGACY_BOOT_SERVICE_NAMES].map((names) =>
    path.join(unitDir, names.unitFile),
  );
});
