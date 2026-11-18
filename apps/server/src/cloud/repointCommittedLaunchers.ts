import * as HostProcess from "@goat/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { pinnedRuntimePaths, pinnedRuntimeVersionsDir } from "./pinnedRuntime.ts";

/**
 * After this start committed a remote update, moves the goat symlinks that point into this
 * home's runtimes to the new one: the recorded launchers (a service does not see the installer's
 * GOAT_INSTALL_BIN_DIR), the default install directory, and the first goat on PATH. A link
 * elsewhere, or a regular file, is left alone. Windows shims are not moved here.
 */
export const repointCommittedLaunchers = Effect.fn("cloud.repoint_committed_launchers")(
  function* (input: { readonly baseDir: string; readonly targetVersion: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const environment = yield* HostProcess.Environment;
    const platform = yield* HostProcess.Platform;
    const home = yield* HostProcess.HomeDirectory;
    if (platform !== "linux" && platform !== "darwin") return;
    const candidates = new Set<string>();
    const recorded = yield* fs
      .readFileString(path.join(input.baseDir, "runtime", "launchers"))
      .pipe(Effect.orElseSucceed(() => ""));
    for (const line of recorded.split(/\r?\n/)) {
      if (path.isAbsolute(line.trim())) candidates.add(line.trim());
    }
    const installBinDir = environment["GOAT_INSTALL_BIN_DIR"] || path.join(home, ".local", "bin");
    candidates.add(path.join(installBinDir, "goat"));
    for (const directory of (environment["PATH"] ?? "").split(":")) {
      if (!path.isAbsolute(directory)) continue;
      const candidate = path.join(directory, "goat");
      if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        candidates.add(candidate);
        break;
      }
    }
    const versionsDir = pinnedRuntimeVersionsDir(path, input.baseDir);
    const target = pinnedRuntimePaths(path, input.baseDir, input.targetVersion, platform);
    for (const launcher of candidates) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const linkTarget = yield* fs.readLink(launcher).pipe(Effect.option);
          if (Option.isNone(linkTarget)) return;
          const relative = path.relative(
            versionsDir,
            path.resolve(path.dirname(launcher), linkTarget.value),
          );
          if (
            relative.length === 0 ||
            relative === ".." ||
            relative.startsWith(".." + path.sep) ||
            path.isAbsolute(relative)
          )
            return;
          // A new link renamed over the old one, so the command never disappears.
          const temporary = yield* fs.makeTempDirectoryScoped({
            directory: path.dirname(launcher),
            prefix: ".goat-launcher-",
          });
          const link = path.join(temporary, "goat");
          yield* fs.symlink(target.entryPath, link);
          yield* fs.rename(link, launcher);
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("Could not move the goat command to the updated version", {
                launcher,
                cause,
              }),
        ),
      );
    }
  },
);
