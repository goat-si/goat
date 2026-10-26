// @effect-diagnostics nodeBuiltinImport:off - a no-follow directory handle has no Effect FileSystem equivalent.
/**
 * A linked git worktree gets its own (gitignored) `.t3`: feature work in a
 * throwaway branch must not share a database with the real app, and an ambient
 * `GOAT_HOME` counts as an explicit base dir — flipping the state directory
 * from `<base>/dev` to `<base>/userdata`, the live production database.
 */

import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { resolveGoatHome } from "./goatHome.ts";
import * as HostProcess from "./HostProcess.ts";

/**
 * The common dir is not necessarily named `.git`: a worktree of a bare repo
 * points at `<repo>.git/worktrees/<name>`, and `$GIT_COMMON_DIR` can be
 * anything. So match on the `worktrees/<name>` tail, which git always uses,
 * rather than on the name of the directory containing it.
 */
const pointsAtLinkedWorktree = (gitFileContents: string, path: Path.Path): boolean => {
  const gitdir = gitFileContents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("gitdir:"))
    ?.slice("gitdir:".length)
    .trim();
  if (gitdir === undefined || gitdir.length === 0) {
    return false;
  }
  const segments = path
    .normalize(gitdir.replaceAll("\\", "/"))
    .split(/[/\\]/)
    .filter((segment) => segment.length > 0);
  return segments.length >= 3 && segments.at(-2) === "worktrees";
};

export const resolveGitWorktreePath = Effect.fn("devHome.resolveGitWorktreePath")(function* (
  cwd: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  let directory = path.resolve(cwd);
  for (;;) {
    const gitPath = path.join(directory, ".git");
    const info = yield* fileSystem.stat(gitPath).pipe(Effect.option);
    if (Option.isSome(info)) {
      if (info.value.type !== "File") {
        return undefined;
      }
      const contents = yield* fileSystem
        .readFileString(gitPath)
        .pipe(Effect.orElseSucceed(() => ""));
      return pointsAtLinkedWorktree(contents, path) ? directory : undefined;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
});

/**
 * The worktree-local data directory for `cwd`, or undefined outside a linked
 * worktree. Deliberately does not require the directory to exist yet: falling
 * back because it is missing would send callers at the shared home.
 * A worktree set up before the GOAT rename keeps its `.t3` (see `resolveGoatHome`).
 */
export const resolveWorktreeHome = Effect.fn("devHome.resolveWorktreeHome")(function* (
  cwd: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const worktreePath = yield* resolveGitWorktreePath(cwd);
  if (worktreePath === undefined) {
    return undefined;
  }
  // The dev runner hands this home to the server as an explicit base dir, which reads userdata.
  return yield* resolveGoatHome(worktreePath, "userdata");
});

export class DevStateDirectorySymlinkError extends Schema.TaggedError<DevStateDirectorySymlinkError>()(
  "DevStateDirectorySymlinkError",
  { directory: Schema.String },
) {
  override get message(): string {
    return `${this.directory} is a symlink. Dev state must be a real directory; replace the link with a directory.`;
  }
}

export class DevStateDirectoryPermissionError extends Schema.TaggedError<DevStateDirectoryPermissionError>()(
  "DevStateDirectoryPermissionError",
  { directory: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not remove group and other write permission from ${this.directory}: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`;
  }
}

// One no-follow handle for the check and the change, so a parent others can
// write cannot swap in a link between them.
const removeGroupAndOtherWrite = async (directory: string) => {
  const handle = await NodeFSP.open(
    directory,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW,
  );
  try {
    const { mode } = await handle.stat();
    if ((mode & 0o022) === 0) return undefined;
    const privateMode = mode & 0o7755;
    await handle.chmod(privateMode);
    return { from: mode & 0o7777, to: privateMode };
  } finally {
    await handle.close();
  }
};

/**
 * Creates a dev state directory without group or other access, or removes
 * group and other write from an existing one, and returns the mode change.
 * The server keeps an existing state directory's mode and its memory import
 * rejects one others can write (#1648), so a home created under umask 002
 * would stay broken. A symlink (or Windows junction) is refused rather than
 * followed: callers rebuild what is inside it.
 */
export const ensurePrivateDevDirectory = Effect.fn("devHome.ensurePrivateDevDirectory")(function* (
  directory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  // A recursive mkdir applies the mode to every directory it creates.
  yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 });
  if ((yield* HostProcess.Platform) === "win32") {
    // No POSIX modes to fix, but a junction must still not be followed.
    if (yield* Effect.isSuccess(fileSystem.readLink(directory))) {
      return yield* new DevStateDirectorySymlinkError({ directory });
    }
    return undefined;
  }
  return yield* Effect.tryPromise({
    try: () => removeGroupAndOtherWrite(directory),
    // After the mkdir above the path is a directory or a link to one, and a
    // no-follow open of a link fails with ELOOP (Linux) or ENOTDIR (macOS).
    catch: (cause) =>
      Predicate.hasProperty(cause, "code") && (cause.code === "ELOOP" || cause.code === "ENOTDIR")
        ? new DevStateDirectorySymlinkError({ directory })
        : new DevStateDirectoryPermissionError({ directory, cause }),
  });
});

export const describePrivateDevDirectoryChange = (
  directory: string,
  change: { readonly from: number; readonly to: number },
): string =>
  `Removed group and other write permission from ${directory} (${change.from.toString(8)} -> ${change.to.toString(8)}); the GOAT server's memory import rejects a state directory others can write.`;
