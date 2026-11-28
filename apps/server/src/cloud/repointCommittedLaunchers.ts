import * as HostProcess from "@goat/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { posixLauncherTarget, writePosixLauncher } from "./posixLauncher.ts";

import {
  launcherOwnsVersionsDir,
  pinnedRuntimePaths,
  pinnedRuntimeVersionsDir,
} from "./pinnedRuntime.ts";

/**
 * After this start committed a remote update, moves the goat launchers that point into this
 * home's runtimes to the new one: the recorded launchers (a service does not see the installer's
 * GOAT_INSTALL_BIN_DIR), the default install directory, and the first goat on PATH. A link
 * elsewhere, or an unrelated file, is left alone. Windows shims are not moved here.
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
    const searchPath = environment["PATH"] ?? "";
    const cwd = yield* HostProcess.WorkingDirectory;
    for (const directory of searchPath.split(":")) {
      if (directory.length === 0 && searchPath.length === 0) continue;
      const candidate = path.resolve(cwd, directory, "goat");
      const info = yield* fs.stat(candidate).pipe(Effect.option);
      if (Option.isSome(info) && info.value.type === "File" && (info.value.mode & 0o111) !== 0) {
        candidates.add(candidate);
        break;
      }
    }
    const versionsDir = pinnedRuntimeVersionsDir(path, input.baseDir);
    const realVersionsDir = yield* fs.realPath(versionsDir).pipe(Effect.option);
    if (Option.isNone(realVersionsDir)) return;
    const target = pinnedRuntimePaths(path, input.baseDir, input.targetVersion, platform);
    const destination = yield* fs.realPath(target.entryPath).pipe(Effect.option);
    if (
      Option.isNone(destination) ||
      !launcherOwnsVersionsDir(path, realVersionsDir.value, destination.value)
    )
      return;
    for (const launcher of candidates) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const lexicalTarget = yield* Effect.promise(() => posixLauncherTarget(launcher));
          if (lexicalTarget === undefined) return;
          if (!launcherOwnsVersionsDir(path, versionsDir, lexicalTarget)) return;
          const resolved = yield* fs.realPath(lexicalTarget).pipe(Effect.option);
          if (
            Option.isNone(resolved) ||
            !launcherOwnsVersionsDir(path, realVersionsDir.value, resolved.value)
          )
            return;
          yield* Effect.promise(() => writePosixLauncher(launcher, target.entryPath));
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
