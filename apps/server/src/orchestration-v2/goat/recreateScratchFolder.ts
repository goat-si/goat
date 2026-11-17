import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";

/**
 * A No project thread whose folder was deleted from Settings → Storage gets an empty folder back
 * before its next turn or terminal, only directly inside <GOAT home>/scratch. The caller holds the
 * folder's workspace lease. Succeeds with whether it made the folder.
 */
export const makeRecreateScratchFolder = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  return Effect.fn("ThreadWorkspace.recreateScratchFolder")(
    function* (worktreePath: string) {
      if (yield* fs.exists(worktreePath)) return false;
      const root = yield* fs.realPath(path.join(config.baseDir, "scratch"));
      const parent = yield* fs.realPath(path.dirname(worktreePath));
      if (parent !== root) return false;
      yield* fs.makeDirectory(worktreePath);
      return true;
    },
    // The turn or terminal then reports the missing folder itself.
    Effect.catch((cause) =>
      Effect.logWarning("could not recreate a No project folder", { cause }).pipe(Effect.as(false)),
    ),
  );
});
