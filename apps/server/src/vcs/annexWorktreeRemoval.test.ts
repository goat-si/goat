// @effect-diagnostics nodeBuiltinImport:off -- inspect actual symlinks in the worktree.
import * as NodeFS from "node:fs";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { GitCommandError } from "@goat/contracts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { isLinkedWorktree, removeLinkedWorktree } from "./worktreeRemoval.ts";
import {
  git,
  initRepoWithCommit,
  layerTest,
  makeTmpDir,
  writeTextFile,
} from "./testing/gitFixture.ts";

it.effect("reports a failed annex link restoration and preserves the backup", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    const { initialBranch } = yield* initRepoWithCommit(cwd);
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const worktree = path.join(yield* makeTmpDir(), "annex-restore");
    yield* driver.createWorktree({
      cwd,
      path: worktree,
      refName: initialBranch,
      newRefName: "annex-restore",
    });
    const gitFile = path.join(worktree, ".git");
    const admin = yield* git(worktree, ["rev-parse", "--absolute-git-dir"]);
    yield* fs.remove(gitFile);
    yield* fs.symlink(admin, gitFile);
    let backup = "";
    const failingFs = FileSystem.FileSystem.of({
      ...fs,
      rename: (from, to) => {
        if (to === gitFile && path.basename(from) === "git-link") {
          backup = from;
          return fs.rename(`${from}-missing`, to);
        }
        return fs.rename(from, to);
      },
    });
    const result = yield* removeLinkedWorktree({
      operation: "test",
      cwd,
      worktreePath: worktree,
      force: false,
      execute: driver.execute,
      run: () =>
        Effect.fail(
          new GitCommandError({ operation: "test", command: "git", cwd, detail: "refused" }),
        ),
    }).pipe(Effect.provideService(FileSystem.FileSystem, failingFs), Effect.result);
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) assert.include(result.failure.detail, backup);
    assert.isNotEmpty(backup);
    assert.isTrue(yield* fs.exists(backup));
    assert.isTrue(NodeFS.lstatSync(backup).isSymbolicLink());
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps the annex symlink on refusal and removes a verified annex worktree", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    const { initialBranch } = yield* initRepoWithCommit(cwd);
    const path = yield* Path.Path;
    const worktree = path.join(yield* makeTmpDir(), "annexed");
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.createWorktree({
      cwd,
      path: worktree,
      refName: initialBranch,
      newRefName: "feature/annexed",
    });
    const gitFile = path.join(worktree, ".git");
    const admin = yield* git(worktree, ["rev-parse", "--absolute-git-dir"]);
    NodeFS.rmSync(gitFile);
    NodeFS.symlinkSync(admin, gitFile);
    yield* writeTextFile(worktree, "notes.txt", "draft\n");
    const refused = yield* Effect.result(driver.removeWorktree({ cwd, path: worktree }));
    assert.isTrue(Result.isFailure(refused));
    assert.isTrue(NodeFS.lstatSync(gitFile).isSymbolicLink());
    NodeFS.rmSync(path.join(worktree, "notes.txt"));
    yield* driver.removeWorktree({ cwd, path: worktree });
    assert.isFalse(NodeFS.existsSync(worktree));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects an annex link whose admin backlink names another worktree", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    const { initialBranch } = yield* initRepoWithCommit(cwd);
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const first = path.join(yield* makeTmpDir(), "first");
    const second = path.join(yield* makeTmpDir(), "second");
    yield* driver.createWorktree({
      cwd,
      path: first,
      refName: initialBranch,
      newRefName: "feature/first",
    });
    yield* driver.createWorktree({
      cwd,
      path: second,
      refName: initialBranch,
      newRefName: "feature/second",
    });
    const firstAdmin = yield* git(first, ["rev-parse", "--absolute-git-dir"]);
    const link = path.join(second, ".git");
    NodeFS.rmSync(link);
    NodeFS.symlinkSync(firstAdmin, link);
    assert.isFalse(yield* isLinkedWorktree(second));
    const result = yield* driver
      .removeWorktree({ cwd, path: second, force: true })
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(result));
    assert.isTrue(NodeFS.lstatSync(link).isSymbolicLink());
    assert.isTrue(NodeFS.existsSync(first));
  }).pipe(Effect.provide(layerTest)),
);
