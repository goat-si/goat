import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";

/**
 * Whether this is the server GOAT runs for SSH clients (base directory `~/.goat`) while the
 * packaged GOAT app's own server (`~/.goat/desktop`, see `resolveDesktopBaseDir`) is live on the
 * same host. SSH clients prefer the app's server, so the descriptor tells an attached client to
 * move once this server has no work left. Any read failure answers false: clients then stay put.
 */
export const makeAppServerLive = Effect.fn("ServerEnvironment.makeAppServerLive")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const sshHome = path.join(home, ".goat");
  const runtimeFile = path.join(sshHome, "desktop", "userdata", "server-runtime.json");
  // SSH clients never probe Windows hosts for the app's server.
  const applies = platform !== "win32" && path.resolve(config.baseDir) === path.resolve(sshHome);
  return applies
    ? readPersistedServerRuntimeState(runtimeFile).pipe(
        Effect.map(
          (state) =>
            Option.isSome(state) &&
            state.value.pid !== process.pid &&
            isProcessAlive(state.value.pid),
        ),
        Effect.orElseSucceed(() => false),
        Effect.provideService(FileSystem.FileSystem, fs),
      )
    : Effect.succeed(false);
});
