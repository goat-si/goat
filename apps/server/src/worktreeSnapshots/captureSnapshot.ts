// @effect-diagnostics nodeBuiltinImport:off - snapshot limits require lstat without following symlinks.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { WorktreeSnapshotError } from "./WorktreeSnapshotStore.ts";

export interface CapturedWorktreeSnapshot {
  readonly headSha: string;
  readonly indexSha: string;
  readonly snapshotSha: string;
  readonly treeSha: string;
  readonly indexTreeSha: string;
}

const isWorktreeSnapshotError = Schema.is(WorktreeSnapshotError);

const identity = {
  GIT_AUTHOR_NAME: "GOAT",
  GIT_AUTHOR_EMAIL: "goat@localhost",
  GIT_COMMITTER_NAME: "GOAT",
  GIT_COMMITTER_EMAIL: "goat@localhost",
};

const program = Effect.fn("WorktreeSnapshot.capture")(function* (cwd: string) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fail = (detail: string) => new WorktreeSnapshotError({ worktreePath: cwd, detail });
  const run = Effect.fn("WorktreeSnapshot.git")(function* (
    args: string[],
    env?: NodeJS.ProcessEnv,
  ) {
    const result = yield* git.execute({
      operation: "WorktreeSnapshot.git",
      cwd,
      args,
      ...(env === undefined ? {} : { env }),
      maxOutputBytes: 16 * 1024 * 1024,
    });
    if (result.stdoutTruncated || result.stderrTruncated)
      return yield* fail("Git output exceeded snapshot inspection limit");
    return result.stdout;
  });
  const gitDir = (yield* run(["rev-parse", "--absolute-git-dir"])).trim();
  for (const name of [
    "MERGE_HEAD",
    "rebase-merge",
    "rebase-apply",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
  ]) {
    if (yield* fs.exists(path.join(gitDir, name)))
      return yield* fail(`Git operation in progress: ${name}`);
  }
  if ((yield* run(["for-each-ref", "--format=%(refname)", "refs/worktree", "refs/bisect"])).trim())
    return yield* fail("per-worktree refs exist");
  if ((yield* run(["ls-files", "-u", "-z"])).length) return yield* fail("unmerged entries exist");
  const flags = (yield* run(["ls-files", "-v", "-z"])).split("\0").filter(Boolean);
  for (const entry of flags) {
    const tag = entry[0] ?? "";
    if (tag >= "a" && tag <= "z") return yield* fail("assume-unchanged entry exists");
    if (tag === "S" && (yield* fs.exists(path.join(cwd, entry.slice(2)))))
      return yield* fail("skip-worktree entry exists on disk");
  }
  const debug = yield* run(["ls-files", "--debug", "-z"]);
  if (
    [...debug.matchAll(/flags: ([0-9a-f]+)/g)].some(
      (match) => (parseInt(match[1] ?? "0", 16) & 0x20000000) !== 0,
    )
  )
    return yield* fail("intent-to-add entry exists");
  // Snapshots record submodule commits only; cleanup's submodule check keeps dirty or unpushed ones first.
  const names = new Set(
    [
      ...(yield* run(["diff", "--name-only", "-z", "HEAD", "--"])).split("\0"),
      ...(yield* run(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0"),
    ].filter(Boolean),
  );
  let total = 0;
  for (const name of names) {
    const target = path.join(cwd, name);
    const stat = yield* Effect.tryPromise({
      try: () => NodeFSP.lstat(target),
      catch: (cause) =>
        new WorktreeSnapshotError({
          worktreePath: cwd,
          detail: "cannot inspect changed file",
          cause,
        }),
    }).pipe(
      Effect.catchIf(
        (cause) =>
          cause.cause instanceof Error && "code" in cause.cause && cause.cause.code === "ENOENT",
        () => Effect.succeed(null),
      ),
    );
    if (stat === null) continue;
    total += Number(stat.size);
    if (Number(stat.size) > 100 * 1024 * 1024 || total > 256 * 1024 * 1024)
      return yield* fail("changed files exceed snapshot size limit");
  }
  const headSha = (yield* run(["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  const indexTreeSha = (yield* run(["write-tree"])).trim();
  const indexSha = (yield* run(
    ["commit-tree", indexTreeSha, "-p", headSha, "-m", "goat index snapshot"],
    identity,
  )).trim();
  const indexPath = (yield* run(["rev-parse", "--git-path", "index"])).trim();
  const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "goat-snapshot-" });
  const tempIndex = path.join(tmp, "index");
  yield* fs.copyFile(path.resolve(cwd, indexPath), tempIndex);
  const env = { ...identity, GIT_INDEX_FILE: tempIndex };
  yield* run(["add", "-A", "--"], env);
  // A nested repository is only a gitlink here: its files and history would be lost. Registered
  // submodules pass, since cleanup's submodule check keeps dirty or unpushed ones first.
  const gitlinks = (output: string) =>
    output
      .split("\0")
      .filter((entry) => entry.startsWith("160000 "))
      .map((entry) => entry.slice(entry.indexOf("\t") + 1));
  const links = gitlinks(yield* run(["ls-files", "-s", "-z"], env));
  if (links.length > 0) {
    const registered = (yield* fs.exists(path.join(cwd, ".gitmodules")))
      ? new Set(
          (yield* run([
            "config",
            "-z",
            "-f",
            ".gitmodules",
            "--get-regexp",
            "^submodule\\..*\\.path$",
          ]).pipe(Effect.orElseSucceed(() => "")))
            .split("\0")
            .filter(Boolean)
            .map((entry) => entry.slice(entry.indexOf("\n") + 1)),
        )
      : new Set<string>();
    for (const link of links)
      if (!registered.has(link) && (yield* fs.exists(path.join(cwd, link, ".git"))))
        return yield* fail(`contains a nested Git repository (${link})`);
  }
  const treeSha = (yield* run(["write-tree"], env)).trim();
  const snapshotSha = (yield* run(
    ["commit-tree", treeSha, "-p", headSha, "-p", indexSha, "-m", "goat worktree snapshot"],
    identity,
  )).trim();
  return { headSha, indexSha, snapshotSha, treeSha, indexTreeSha };
});

export const captureWorktreeSnapshot = Effect.fn("WorktreeSnapshot.captureWorktreeSnapshot")(
  function* (input: { readonly cwd: string; readonly threadId: string; readonly now: number }) {
    return yield* Effect.scoped(program(input.cwd)).pipe(
      Effect.mapError((cause) =>
        isWorktreeSnapshotError(cause)
          ? cause
          : new WorktreeSnapshotError({
              worktreePath: input.cwd,
              detail: "snapshot capture failed",
              cause,
            }),
      ),
    );
  },
);

export const verifySnapshot = Effect.fn("WorktreeSnapshot.verifySnapshot")(function* (
  cwd: string,
  snapshot: CapturedWorktreeSnapshot & { readonly snapshotRef: string },
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const changed = () =>
    new WorktreeSnapshotError({ worktreePath: cwd, detail: "changed while cleaning up" });
  const check = Effect.gen(function* () {
    const commit = yield* git.execute({
      operation: "WorktreeSnapshot.verify",
      cwd,
      args: ["rev-parse", "--verify", `${snapshot.snapshotRef}^{commit}`],
    });
    const tree = yield* git.execute({
      operation: "WorktreeSnapshot.verify",
      cwd,
      args: ["rev-parse", "--verify", `${snapshot.snapshotRef}^{tree}`],
    });
    const current = yield* Effect.scoped(program(cwd));
    if (
      commit.stdout.trim() !== snapshot.snapshotSha ||
      tree.stdout.trim() !== snapshot.treeSha ||
      current.treeSha !== snapshot.treeSha ||
      current.indexTreeSha !== snapshot.indexTreeSha ||
      current.headSha !== snapshot.headSha
    )
      return yield* changed();
  });
  return yield* check.pipe(Effect.mapError(() => changed()));
});
