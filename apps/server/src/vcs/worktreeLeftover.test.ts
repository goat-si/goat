import * as HostProcess from "@goat/shared/HostProcess";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  git,
  initRepoWithCommit,
  layerServerConfig,
  layerTest,
  makeTmpDir,
  writeTextFile,
} from "./testing/gitFixture.ts";

it.layer(layerTest)("generated worktree paths", (it) => {
  it.effect("keeps leftover files and chooses another path", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const worktreesDirectory = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = { cwd, path: null, refName: initialBranch, newRefName: "feature/custom-dir" };
      const created = yield* driver.createWorktree(input, { worktreesDirectory });
      yield* git(cwd, ["worktree", "remove", "--force", created.worktree.path]);
      yield* git(cwd, ["branch", "-D", "feature/custom-dir"]);
      yield* fs.makeDirectory(created.worktree.path);
      yield* fs.writeFileString(path.join(created.worktree.path, "notes.txt"), "my notes");
      const recreated = yield* driver.createWorktree(input, { worktreesDirectory });
      assert.notEqual(recreated.worktree.path, created.worktree.path);
      assert.equal(
        yield* git(recreated.worktree.path, ["branch", "--show-current"]),
        "feature/custom-dir",
      );
      assert.deepEqual(yield* fs.readDirectory(created.worktree.path), ["notes.txt"]);
    }),
  );
  it.effect("removes checkout files before Git drops rollback metadata on Windows", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const destination = path.join(yield* makeTmpDir(), "owned-rollback");
      yield* writeTextFile(cwd, ".git/hooks/post-checkout", "#!/bin/sh\nexit 1\n");
      yield* fs.chmod(path.join(cwd, ".git/hooks/post-checkout"), 0o755);
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const removedByGit: boolean[] = [];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (
            ChildProcess.isStandardCommand(command) &&
            command.args.includes("remove") &&
            command.args.includes("worktree") &&
            command.args.includes(destination)
          ) {
            removedByGit.push(yield* fs.exists(path.join(destination, ".git")));
          }
          return yield* delegate.spawn(command);
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(layerServerConfig),
      );
      yield* Effect.flip(
        driver.createWorktree({
          cwd,
          path: destination,
          refName: initialBranch,
          newRefName: "feature/windows-rollback",
        }),
      ).pipe(Effect.provideService(HostProcess.Platform, "win32"));
      assert.deepEqual(removedByGit, [false]);
      assert.isFalse(yield* fs.exists(destination));
    }),
  );
});
