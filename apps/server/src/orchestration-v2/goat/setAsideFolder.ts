import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";

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
  const restoreEntries = Effect.fn("WorktreeSetAside.restoreEntries")(
    function* (workspace: string, setAsidePath: string) {
      const entries = yield* fs.readDirectory(setAsidePath);
      const target = yield* fs.readDirectory(workspace);
      for (const entry of entries) {
        if (target.includes(entry)) return false;
      }
      for (const entry of entries) {
        yield* fs.rename(path.join(setAsidePath, entry), path.join(workspace, entry));
      }
      yield* fs.remove(setAsidePath);
      return true;
    },
    Effect.catch((cause) =>
      Effect.logWarning("worktree leftovers stayed in their set-aside folder", {
        cause,
      }).pipe(Effect.as(false)),
    ),
  );

  const moveEntries = Effect.fn("WorktreeSetAside.moveEntries")(function* (
    workspace: string,
    error: PlatformError,
    held: { path: string | null },
  ) {
    if (
      (error.reason._tag !== "Busy" && error.reason._tag !== "PermissionDenied") ||
      (yield* contents(workspace)) !== "leftovers"
    )
      return yield* error;
    const entries = yield* fs.readDirectory(workspace);
    if (entries.some((entry) => !LEFTOVER_ENTRIES.has(entry))) return yield* error;
    const setAsidePath = yield* fs.makeTempDirectory({
      directory: path.dirname(workspace),
      prefix: `${path.basename(workspace)}-set-aside-`,
    });
    held.path = setAsidePath;
    yield* Effect.forEach(
      entries,
      (entry) => fs.rename(path.join(workspace, entry), path.join(setAsidePath, entry)),
      { discard: true },
    ).pipe(
      Effect.onError(() =>
        restoreEntries(workspace, setAsidePath).pipe(
          Effect.tap((back) => {
            if (back) held.path = null;
          }),
        ),
      ),
    );
    return { setAsidePath, movedEntries: true };
  });

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
          return yield* fs.rename(worktreePath, setAsidePath).pipe(
            Effect.map(() => {
              held.path = setAsidePath;
              return { setAsidePath, movedEntries: false };
            }),
            Effect.catch((error) => moveEntries(worktreePath, error, held)),
          );
        }),
        ({ setAsidePath }) => Effect.map(recreate, (result) => ({ result, setAsidePath })),
        ({ setAsidePath, movedEntries }, exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : (movedEntries
                ? restoreEntries(worktreePath, setAsidePath)
                : putBack(worktreePath, setAsidePath)
              ).pipe(
                Effect.map((back) => {
                  if (back) held.path = null;
                }),
              ),
      ),
  };
});
