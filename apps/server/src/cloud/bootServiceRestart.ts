import { DESKTOP_UPDATE_RESTART_MARKER_FILE } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type { BootServiceStep } from "./bootService.ts";
import type { BootServiceCommandError } from "./bootServiceErrors.ts";

export const makeStopForRestart = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  baseDir: string,
  runSteps: (steps: ReadonlyArray<BootServiceStep>) => Effect.Effect<void, BootServiceCommandError>,
) => {
  const marker = path.join(baseDir, "runtime", DESKTOP_UPDATE_RESTART_MARKER_FILE);
  return (steps: ReadonlyArray<BootServiceStep>, queued = false) =>
    Effect.acquireUseRelease(
      fs.writeFileString(marker, "", { mode: 0o600 }).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("Could not mark the service restart to preserve its relay tunnel", {
            errorTag: error._tag,
          }).pipe(Effect.as(false)),
        ),
      ),
      () => runSteps(steps),
      (marked, exit) =>
        marked && (!queued || Exit.isFailure(exit))
          ? fs.remove(marker, { force: true }).pipe(Effect.ignore)
          : Effect.void,
    );
};
