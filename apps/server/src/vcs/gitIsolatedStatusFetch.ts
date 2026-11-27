import { GitCommandError } from "@goat/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type { ExecuteGitResult } from "./GitVcsDriver.ts";

export const makeIsolatedStatusFetch = Effect.fn("GitVcsDriver.makeIsolatedStatusFetch")((input: {
  gitCommonDir: string;
  remoteName: string;
  fetchCwd: string;
  path: Path.Path;
  fileSystem: FileSystem.FileSystem;
  hostPlatform: string;
  timeout: Duration.Duration;
  refreshEnv: NodeJS.ProcessEnv;
  executeGit: (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: {
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      forceKillAfterMs?: number;
      fallbackErrorDetail?: string;
    },
  ) => Effect.Effect<ExecuteGitResult, GitCommandError>;
  runGitStdout: (
    operation: string,
    cwd: string,
    args: readonly string[],
  ) => Effect.Effect<string, GitCommandError>;
}) => {
  const {
    gitCommonDir,
    remoteName,
    fetchCwd,
    path,
    fileSystem,
    hostPlatform,
    timeout,
    refreshEnv,
    executeGit,
    runGitStdout,
  } = input;
  // Makes Git write new objects to `privateObjects` and read the repository's. Lists every object
  // directory Git resolved (`count-objects -v` output) flat, since nesting the repository's objects
  // one level deeper can pass Git's depth limit.
  const privateObjectDirectoryEnv = (
    privateObjects: string,
    repositoryObjects: string,
    countObjects: string,
  ) => {
    // Git prints an entry C-quoted when it needs quoting; quote the rest the same way, so a
    // path holding the list separator stays one entry (Git 2.11.1+).
    const quoted = (entry: string) =>
      entry.startsWith('"') ? entry : `"${entry.replace(/[\\"]/g, "\\$&")}"`;
    const alternates = [
      repositoryObjects,
      ...countObjects
        .split("\n")
        .flatMap((line) =>
          line.startsWith("alternate: ") ? [line.slice("alternate: ".length)] : [],
        ),
    ];
    return {
      GIT_OBJECT_DIRECTORY: privateObjects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates
        .map(quoted)
        .join(hostPlatform === "win32" ? ";" : ":"),
    } satisfies NodeJS.ProcessEnv;
  };

  // Moves finished packs and loose objects into the repository, as Git's own quarantine does. A
  // pack's index goes last: Git reads a pack as soon as it sees the index.
  const adoptPrivateObjects = Effect.fn("GitVcsDriver.adoptPrivateObjects")(function* (
    privateObjects: string,
    repositoryObjects: string,
  ) {
    for (const directory of yield* fileSystem.readDirectory(privateObjects)) {
      if (directory !== "pack" && !/^[0-9a-f]{2}$/.test(directory)) continue;
      const names = (yield* fileSystem.readDirectory(path.join(privateObjects, directory)))
        .filter((name) => !name.startsWith("tmp_"))
        .toSorted((a, b) => Number(a.endsWith(".idx")) - Number(b.endsWith(".idx")));
      if (names.length === 0) continue;
      yield* fileSystem.makeDirectory(path.join(repositoryObjects, directory), { recursive: true });
      for (const name of names) {
        const target = path.join(repositoryObjects, directory, name);
        if (yield* fileSystem.exists(target)) continue;
        yield* fileSystem.rename(path.join(privateObjects, directory, name), target);
      }
    }
  });

  // `--no-auto-gc` (a synonym of `--no-auto-maintenance` that older Git also knows) keeps
  // this poll from starting `git gc --auto`. When that gc fails, for example on a repository
  // with missing objects, Git retries it on every fetch and leaves a full-size `tmp_pack_*`
  // behind each time, so a background poll could fill the disk.
  const fetchArgs = (mode: "--dry-run" | "--quiet") => [
    "--git-dir",
    gitCommonDir,
    "fetch",
    mode,
    "--no-tags",
    "--no-auto-gc",
    "--no-write-fetch-head",
    "--",
    remoteName,
  ];
  const objectsPath = path.join(gitCommonDir, "objects");
  const fetchOptions = {
    fallbackErrorDetail: "Background Git fetch exited with a non-zero status.",
    timeoutMs: Duration.toMillis(timeout),
    forceKillAfterMs: 1_000,
  };
  // A failed or killed fetch leaves its partial `tmp_pack_*` behind, and nothing tells it apart
  // from another Git process's. So the download goes to a directory only this fetch writes to,
  // named like Git's own quarantine so `git gc` prunes one a crash left. A dry run downloads
  // without moving refs, which must not point at objects the repository does not hold yet.
  const isolatedFetch = Effect.acquireUseRelease(
    fileSystem.makeTempDirectory({ directory: objectsPath, prefix: "tmp_objdir-goat-" }),
    Effect.fnUntraced(function* (privateObjects) {
      const objectDirectories = yield* runGitStdout(
        "GitVcsDriver.fetchRemoteForStatus.alternates",
        fetchCwd,
        ["--git-dir", gitCommonDir, "count-objects", "-v"],
      );
      const options = (writableObjects: string) => ({
        ...fetchOptions,
        env: {
          ...refreshEnv,
          ...privateObjectDirectoryEnv(writableObjects, objectsPath, objectDirectories),
        },
      });
      const { stderr } = yield* executeGit(
        "GitVcsDriver.fetchRemoteForStatus.download",
        fetchCwd,
        fetchArgs("--dry-run"),
        options(privateObjects),
      );
      yield* adoptPrivateObjects(privateObjects, objectsPath);
      // A dry run names each ref it would move on stderr and is silent when none would.
      if (stderr.trim() === "") return;
      // This fetch may only move refs to objects the repository now holds. If the remote moved
      // on since the dry run it would download, so it gets an object directory where `pack` is
      // a file and every transfer is a pack: it then fails, moves nothing, and the next poll
      // downloads. Git reports the unreadable `pack` on stderr and carries on.
      const sealedObjects = path.join(privateObjects, "sealed");
      yield* fileSystem.makeDirectory(sealedObjects);
      yield* fileSystem.writeFileString(path.join(sealedObjects, "pack"), "");
      yield* executeGit(
        "GitVcsDriver.fetchRemoteForStatus",
        fetchCwd,
        ["-c", "fetch.unpackLimit=1", ...fetchArgs("--quiet")],
        options(sealedObjects),
      );
    }),
    (privateObjects) =>
      fileSystem
        .remove(privateObjects, { recursive: true, force: true })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not remove a background Git fetch's object directory", cause),
          ),
        ),
  ).pipe(
    Effect.mapError((error) =>
      error._tag === "GitCommandError"
        ? error
        : new GitCommandError({
            operation: "GitVcsDriver.fetchRemoteForStatus",
            command: "git fetch",
            cwd: fetchCwd,
            detail: "Background Git fetch could not use its object directory.",
            cause: error,
          }),
    ),
  );
  return isolatedFetch;
});
