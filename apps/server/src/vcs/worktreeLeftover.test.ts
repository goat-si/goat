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
  it.effect("keeps a failed Windows checkout without invoking Git removal", () =>
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
      assert.isEmpty(removedByGit);
      assert.isTrue(yield* fs.exists(path.join(destination, ".git")));
    }),
  );
  it.effect("preserves a real checkout edit hidden by assume-unchanged when its hook fails", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const destination = path.join(yield* makeTmpDir(), "hidden-edit");
      const hook = ".git/hooks/post-checkout";
      yield* writeTextFile(
        cwd,
        hook,
        "#!/bin/sh\ngit update-index --assume-unchanged README.md\nprintf keep > README.md\nexit 1\n",
      );
      yield* fs.chmod(path.join(cwd, hook), 0o755);
      yield* Effect.flip(
        driver.createWorktree({
          cwd,
          path: destination,
          refName: initialBranch,
          newRefName: "feature/hidden",
        }),
      );
      assert.equal(yield* fs.readFileString(path.join(destination, "README.md")), "keep");
      assert.equal(yield* git(destination, ["status", "--porcelain"]), "");
      assert.equal(yield* git(destination, ["branch", "--show-current"]), "feature/hidden");
    }),
  );

  it.effect("keeps a file written just before Git unlocks a failed checkout", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const destination = path.join(yield* makeTmpDir(), "late-edit");
      const hook = ".git/hooks/post-checkout";
      yield* writeTextFile(cwd, hook, "#!/bin/sh\nexit 1\n");
      yield* fs.chmod(path.join(cwd, hook), 0o755);
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (
            ChildProcess.isStandardCommand(command) &&
            command.args.includes("worktree") &&
            command.args.includes("unlock")
          ) {
            yield* fs.writeFileString(path.join(destination, "late.txt"), "keep");
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
          newRefName: "feature/late",
        }),
      );
      assert.equal(yield* fs.readFileString(path.join(destination, "late.txt")), "keep");
      assert.equal(yield* git(destination, ["branch", "--show-current"]), "feature/late");
    }),
  );
});
