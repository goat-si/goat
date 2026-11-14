import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { BOOT_SERVICE_NAMES, LEGACY_BOOT_SERVICE_NAMES } from "./bootServiceNames.ts";
import { readSystemdUnitDirectory } from "./systemdUnitDirectory.ts";

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
  const unitDir = yield* readSystemdUnitDirectory();
  if (unitDir === undefined) return undefined;
  return [BOOT_SERVICE_NAMES, LEGACY_BOOT_SERVICE_NAMES].map((names) =>
    path.join(unitDir, names.unitFile),
  );
});
