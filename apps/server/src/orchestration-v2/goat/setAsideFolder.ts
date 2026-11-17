import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// `git worktree remove` skips pnpm junctions on Windows, leaving these behind without a checkout.
const LEFTOVER_ENTRIES = new Set(["node_modules", ".next"]);

/** The sentence a restore notice adds when it moved a folder aside to make room. */
export const setAsideSentence = (setAsidePath: string) =>
  `The files that were in the folder are now in ${setAsidePath}.`;

/**
 * A worktree folder that lost its checkout is moved to a visible sibling while a new checkout is
 * made in its place; it stays there once that succeeds, and moves back when it fails. The caller
 * holds the folder's workspace lease and has checked that GOAT made the path.
 */
export const makeSetAsideFolder = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  /** Whether the folder is back in place; when not, its files stay in the set-aside sibling. */
  const putBack = (worktreePath: string, setAsidePath: string) =>
    fs.remove(worktreePath, { recursive: true, force: true }).pipe(
      Effect.andThen(fs.rename(setAsidePath, worktreePath)),
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning("a worktree folder stayed set aside after a failed checkout", {
          worktreePath,
          setAsidePath,
          cause,
        }).pipe(Effect.as(false)),
      ),
    );
  /** What sits at the path when its `.git` link is gone; errors count as a healthy checkout. */
  const contents = (worktreePath: string) =>
    Effect.all([fs.exists(worktreePath), fs.exists(path.join(worktreePath, ".git"))]).pipe(
      Effect.flatMap(([present, linked]) =>
        !present
          ? Effect.succeed("absent" as const)
          : linked
            ? Effect.succeed("checkout" as const)
            : fs.readDirectory(worktreePath).pipe(
                Effect.flatMap((entries) =>
                  Effect.forEach(entries, (entry) =>
                    LEFTOVER_ENTRIES.has(entry)
                      ? fs
                          .stat(path.join(worktreePath, entry))
                          .pipe(Effect.map((info) => info.type === "Directory"))
                      : Effect.succeed(false),
                  ),
                ),
                Effect.map((leftovers) =>
                  leftovers.length === 0
                    ? ("empty" as const)
                    : leftovers.every(Boolean)
                      ? ("leftovers" as const)
                      : ("files" as const),
                ),
              ),
      ),
      Effect.orElseSucceed(() => "checkout" as const),
    );
  return {
    /** Present without its `.git` link and holding something; Git takes an empty folder as it is. */
    lostCheckout: (worktreePath: string) =>
      Effect.map(contents(worktreePath), (found) => found === "leftovers" || found === "files"),
    /** Present without its `.git` link and holding nothing but what a failed removal leaves. */
    leftover: (worktreePath: string) =>
      Effect.map(contents(worktreePath), (found) => found === "leftovers"),
    /** Absent, or an empty folder without a checkout: a new checkout can be made right there. */
    missing: (worktreePath: string) =>
      Effect.map(contents(worktreePath), (found) => found === "absent" || found === "empty"),
    /**
     * Runs `recreate` with the folder set aside and succeeds with where the folder went. `held`
     * names the set-aside folder while the files are there, so a later failure can say where.
     */
    around: <A, E, R>(
      worktreePath: string,
      recreate: Effect.Effect<A, E, R>,
      held: { path: string | null } = { path: null },
    ) =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          const stamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-");
          const setAsidePath = path.join(
            path.dirname(worktreePath),
            `${path.basename(worktreePath)}-set-aside-${stamp}`,
          );
          // Rename refuses a target that holds files, so nothing already there is replaced.
          yield* fs.rename(worktreePath, setAsidePath);
          held.path = setAsidePath;
          return setAsidePath;
        }),
        (setAsidePath) => Effect.map(recreate, (result) => ({ result, setAsidePath })),
        (setAsidePath, exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : putBack(worktreePath, setAsidePath).pipe(
                Effect.map((back) => {
                  if (back) held.path = null;
                }),
              ),
      ),
  };
});
