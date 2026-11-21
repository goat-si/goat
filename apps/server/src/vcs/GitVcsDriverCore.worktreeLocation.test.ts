import { enableWorkspaceLeaseRegistry } from "../workspace/workspaceLeaseRegistry.ts";
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
  it.effect.each(["dead", "live", "legacy"] as const)(
    "recovers or explains a %s creation lock without removing checkout contents",
    (owner) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const claims = yield* makeTmpDir();
        const registry = yield* Effect.acquireRelease(
          Effect.sync(() => enableWorkspaceLeaseRegistry(claims)),
          (registry) => Effect.sync(registry.disable),
        );
        const deadHolder = "1654b026-c775-4ab9-a6cc-776ede502c69";
        const nonce = "2ab3b76b-fa24-48a2-957c-856fff5d9609";
        if (owner === "dead") {
          yield* fs.copyFile(
            path.join(claims, `${registry.holder}.holder`),
            path.join(claims, `${deadHolder}.holder`),
          );
        }
        const input = {
          cwd,
          path: path.join(yield* makeTmpDir(), "reserved"),
          refName: initialBranch,
          newRefName: "feature/recover-lock",
        };
        yield* driver.createWorktree(input);
        const reason =
          owner === "legacy"
            ? `goat-create-${nonce}`
            : `goat-create-${owner === "dead" ? deadHolder : registry.holder}-${nonce}`;
        yield* git(cwd, ["worktree", "lock", "--reason", reason, input.path]);
        const reuse = driver.createWorktree(input, { reuseExistingBranch: true });
        if (owner === "dead") {
          const result = yield* reuse;
          assert.equal(result.worktree.path, input.path);
          assert.notInclude(yield* git(cwd, ["worktree", "list", "--porcelain"]), reason);
        } else {
          const error = yield* Effect.flip(reuse);
          assert.include(error.detail, input.path);
          assert.include(
            error.detail,
            owner === "legacy" ? "git worktree unlock" : "still being prepared",
          );
          assert.include(yield* git(cwd, ["worktree", "list", "--porcelain"]), reason);
        }
        assert.equal(yield* fs.readFileString(path.join(input.path, "README.md")), "# test\n");
      }),
  );
});
