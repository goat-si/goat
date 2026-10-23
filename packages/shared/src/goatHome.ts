import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { LEGACY_HOME_DIR_NAME } from "@goat/contracts/legacyT3Names";

export const GOAT_HOME_DIR_NAME = ".goat";

/**
 * The GOAT home inside `parent` (a user's home directory, or a linked worktree).
 *
 * Builds before the GOAT rename kept their state in `.t3`. That directory stays in use
 * while it holds the state this run reads (`stateDirName`, such as `userdata` or `dev`)
 * and `.goat` does not, so existing data is never orphaned. Nothing is copied: upstream
 * T3 Code may be using `~/.t3` at the same time. // goat-rename: legacy
 */
export const resolveGoatHome = (
  parent: string,
  stateDirName: string,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const goatHome = path.join(parent, GOAT_HOME_DIR_NAME);
    const legacyHome = path.join(parent, LEGACY_HOME_DIR_NAME);
    const holdsState = (home: string) =>
      fileSystem.exists(path.join(home, stateDirName)).pipe(Effect.orElseSucceed(() => false));
    if (yield* holdsState(goatHome)) return goatHome;
    return (yield* holdsState(legacyHome)) ? legacyHome : goatHome;
  });
