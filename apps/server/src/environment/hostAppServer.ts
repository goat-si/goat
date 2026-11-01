import { desktopAppServerStateDirs } from "@goat/shared/desktopAppServer";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

// Only the PID matters here. Importing serverRuntimeState.ts would pull its startup-access
// dependencies into ServerEnvironment and close an import cycle through EnvironmentAuth.
const decodeRuntimePid = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ pid: Schema.Int })),
);

const processRuns = (pid: number) => {
  if (pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return cause instanceof Error && "code" in cause && cause.code === "EPERM";
  }
};

/**
 * Whether this is the server GOAT runs for SSH clients (base directory `~/.goat`) while a
 * desktop app server (`desktopAppServerStateDirs`) is live on the same host. SSH clients prefer
 * the app's server, so the descriptor tells an attached client to move once this server has no
 * work left. Any read failure skips that directory: clients stay put only when none is live.
 */
export const makeAppServerLive = Effect.fn("ServerEnvironment.makeAppServerLive")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const sshHome = path.join(home, ".goat");
  // SSH clients never probe Windows hosts for the app's server.
  if (platform === "win32" || path.resolve(config.baseDir) !== path.resolve(sshHome)) {
    return Effect.succeed(false);
  }
  // Read when the descriptor is built, not when this effect is constructed.
  return Effect.gen(function* () {
    for (const dir of desktopAppServerStateDirs) {
      const text = yield* fs
        .readFileString(path.join(home, ...dir.split("/"), "server-runtime.json"))
        .pipe(Effect.option);
      if (Option.isNone(text)) continue;
      const record = decodeRuntimePid(text.value.trim());
      if (Option.isSome(record) && processRuns(record.value.pid)) return true;
    }
    return false;
  });
});
