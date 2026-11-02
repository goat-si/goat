import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { GitCommandError } from "@goat/contracts";

import * as GitVcsDriver from "./GitVcsDriver.ts";
import { git, initRepoWithCommit, layerTest, makeTmpDir } from "./testing/gitFixture.ts";

it.layer(layerTest)("GitVcsDriver worktree locations", (it) => {
  it.effect("uses the Git repository root when the source cwd is nested", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const repository = yield* makeTmpDir();
      const nested = pathService.join(repository, "packages", "app");
      yield* fileSystem.makeDirectory(nested, { recursive: true });
      const worktreesDirectory = yield* makeTmpDir("custom-worktrees-");
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const notRepository = yield* Effect.flip(
        driver.createWorktree(
          { cwd: nested, path: null, refName: "HEAD", newRefName: "feature/not-repository" },
          { worktreesDirectory },
        ),
      );
      assert.instanceOf(notRepository, GitCommandError);
      const { initialBranch } = yield* initRepoWithCommit(repository);
      const create = (cwd: string, newRefName: string) =>
        driver.createWorktree(
          { cwd, path: null, refName: initialBranch, newRefName },
          { worktreesDirectory },
        );
      const root = yield* create(repository, "feature/root");
      const nestedResult = yield* create(nested, "feature/nested");
      const expectedRoot = pathService.join(worktreesDirectory, pathService.basename(repository));
      assert.equal(pathService.dirname(root.worktree.path), expectedRoot);
      assert.equal(pathService.dirname(nestedResult.worktree.path), expectedRoot);
      assert.equal(yield* fileSystem.exists(root.worktree.path), true);
      assert.equal(yield* fileSystem.exists(nestedResult.worktree.path), true);
    }),
  );

  it.effect("keeps an old scattered checkout when the canonical target conflicts", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const repository = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(repository);
      const nested = pathService.join(repository, "packages", "app");
      yield* fileSystem.makeDirectory(nested, { recursive: true });
      const worktreesDirectory = yield* makeTmpDir("custom-worktrees-");
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const legacyPath = pathService.join(worktreesDirectory, "app", "feature-legacy");
      yield* driver.createWorktree({
        cwd: nested,
        path: legacyPath,
        refName: initialBranch,
        newRefName: "feature/legacy",
      });
      const conflict = yield* Effect.flip(
        driver.createWorktree(
          { cwd: nested, path: null, refName: initialBranch, newRefName: "feature/legacy" },
          { worktreesDirectory, reuseExistingBranch: true },
        ),
      );
      assert.include(conflict.detail, "outside this launch's worktree folder");
      assert.equal(yield* fileSystem.exists(legacyPath), true);
      assert.equal(yield* git(legacyPath, ["branch", "--show-current"]), "feature/legacy");
    }),
  );
});
