import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  layerServerConfig,
  layerTest,
  makeTmpDir,
  git,
  initRepoWithCommit,
} from "./testing/gitFixture.ts";

it.layer(layerTest)("worktree branch allocation", (it) => {
  it.effect("reuses a clean legacy generated worktree on launch retry", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const worktreesDirectory = yield* makeTmpDir();
      const legacy = path.join(worktreesDirectory, path.basename(cwd), "feature-retry");
      yield* driver.createWorktree({
        cwd,
        path: legacy,
        refName: initialBranch,
        newRefName: "feature/retry",
      });
      const result = yield* driver.createWorktree(
        { cwd, path: null, refName: initialBranch, newRefName: "feature/retry" },
        { worktreesDirectory, reuseExistingBranch: true },
      );
      assert.equal(result.worktree.path, legacy);
      assert.equal(yield* git(legacy, ["branch", "--show-current"]), "feature/retry");
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(path.join(legacy, "untracked"), "changes");
      const dirty = yield* driver
        .createWorktree(
          { cwd, path: null, refName: initialBranch, newRefName: "feature/retry" },
          { worktreesDirectory, reuseExistingBranch: true },
        )
        .pipe(Effect.flip);
      assert.include(dirty.detail, "uncommitted changes");
      const explicit = yield* driver
        .createWorktree(
          {
            cwd,
            path: path.join(worktreesDirectory, "other"),
            refName: initialBranch,
            newRefName: "feature/retry",
          },
          { worktreesDirectory, reuseExistingBranch: true },
        )
        .pipe(Effect.flip);
      assert.include(explicit.detail, "outside this launch");
    }),
  );

  it.effect("reuses a long legacy hashed worktree on launch retry", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const worktreesDirectory = yield* makeTmpDir();
      const branch = `feature/${"a".repeat(50)}`;
      const legacy = path.join(
        worktreesDirectory,
        path.basename(cwd),
        `feature-${"a".repeat(15)}-dea33f15896868a3`,
      );
      yield* driver.createWorktree({
        cwd,
        path: legacy,
        refName: initialBranch,
        newRefName: branch,
      });
      const result = yield* driver.createWorktree(
        { cwd, path: null, refName: initialBranch, newRefName: branch },
        { worktreesDirectory, reuseExistingBranch: true },
      );
      assert.equal(result.worktree.path, legacy);
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(path.join(legacy, "unique.txt"), "unique");
      yield* git(legacy, ["add", "unique.txt"]);
      yield* git(legacy, ["commit", "-m", "unique work"]);
      const rejected = yield* driver
        .createWorktree(
          { cwd, path: null, refName: initialBranch, newRefName: branch },
          { worktreesDirectory, reuseExistingBranch: true },
        )
        .pipe(Effect.flip);
      assert.equal(rejected.reason, "branch_already_exists");
      assert.include(rejected.detail, "commit");
    }),
  );
  it.effect.each(["t3", "T3"])("flattens a generated name when parent %s blocks it", (parent) =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      // A local `t3` branch is why launches start on the flat `t3-<hex>` temporary branch.
      yield* git(cwd, ["branch", parent]);
      yield* git(cwd, ["checkout", "-b", "t3-abcd1234"]);
      yield* git(cwd, ["branch", "t3-fix-login"]);

      const renamed = yield* driver.renameBranch({
        cwd,
        oldBranch: "t3-abcd1234",
        newBranch: "t3/fix-login",
      });

      assert.equal(renamed.branch, "t3-fix-login-1");
      assert.equal(yield* git(cwd, ["branch", "--show-current"]), "t3-fix-login-1");
    }),
  );

  it.effect.each(["t3-fix-login/child", "T3-Fix-Login/child", "T3-FIX-LOGIN"])(
    "skips a flattened name blocked by %s",
    (occupied) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "t3"]);
        yield* git(cwd, ["checkout", "-b", "t3-abcd1234"]);
        yield* git(cwd, ["branch", occupied]);

        const renamed = yield* driver.renameBranch({
          cwd,
          oldBranch: "t3-abcd1234",
          newBranch: "t3/fix-login",
        });

        assert.equal(renamed.branch, "t3-fix-login-1");
        assert.equal(yield* git(cwd, ["branch", "--show-current"]), "t3-fix-login-1");
      }),
  );

  it.effect("refuses exhausted automatic suffixes without changing existing branches", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const oid = yield* git(cwd, ["rev-parse", "HEAD"]);
      yield* driver.execute({
        operation: "GitVcsDriver.test.createBranches",
        cwd,
        args: ["update-ref", "--stdin"],
        stdin: Array.from(
          { length: 101 },
          (_, index) => `create refs/heads/${index === 0 ? "topic" : `topic-${index}`} ${oid}\n`,
        ).join(""),
      });
      const result = yield* driver
        .renameBranch({ cwd, oldBranch: initialBranch, newBranch: "topic" })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result))
        assert.include(result.failure.detail, "Could not find an available branch name");
      assert.equal(yield* git(cwd, ["branch", "--show-current"]), initialBranch);
      assert.equal((yield* driver.listLocalBranchNames(cwd)).length, 102);
    }),
  );

  it.effect.each(["rename", "createWorktree"] as const)(
    "preserves a concurrent creator's branch when %s loses the atomic ref operation",
    (operation) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const expected = yield* git(cwd, ["commit-tree", "HEAD^{tree}", "-m", "concurrent winner"]);
        const original = yield* GitVcsDriver.GitVcsDriver;
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        let claimed = false;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (
              !claimed &&
              ChildProcess.isStandardCommand(command) &&
              (operation === "rename"
                ? command.args[0] === "branch" && command.args.includes("-m")
                : command.args.includes("worktree") && command.args.includes("-b"))
            ) {
              claimed = true;
              yield* original
                .execute({
                  cwd,
                  operation: "test.concurrentCreator",
                  args: ["update-ref", "refs/heads/topic", expected, ""],
                })
                .pipe(Effect.orDie);
            }
            return yield* delegate.spawn(command);
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(layerServerConfig),
        );
        const result = yield* (
          operation === "rename"
            ? driver
                .renameBranch({ cwd, oldBranch: initialBranch, newBranch: "topic" })
                .pipe(Effect.asVoid)
            : driver
                .createWorktree({
                  cwd,
                  refName: initialBranch,
                  newRefName: "topic",
                  path: (yield* Path.Path).join(cwd, "checkout"),
                })
                .pipe(Effect.asVoid)
        ).pipe(Effect.result);
        assert.isTrue(claimed);
        assert.isTrue(Result.isFailure(result));
        assert.equal(yield* git(cwd, ["rev-parse", "refs/heads/topic"]), expected);
        assert.equal(yield* git(cwd, ["branch", "--show-current"]), initialBranch);
      }),
  );

  it.effect(
    "keeps generated paths distinct across branch spellings and equal repository basenames",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeTmpDir();
        const worktreesDirectory = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const paths = new Set<string>();
        for (const owner of ["one", "two"]) {
          const cwd = path.join(root, owner, "repository");
          yield* fs.makeDirectory(cwd, { recursive: true });
          const { initialBranch } = yield* initRepoWithCommit(cwd);
          for (const branch of ["feat/a", "feat-a"]) {
            const created = yield* driver.createWorktree(
              { cwd, path: null, refName: initialBranch, newRefName: branch },
              { worktreesDirectory },
            );
            paths.add(created.worktree.path);
            assert.equal(yield* git(created.worktree.path, ["branch", "--show-current"]), branch);
          }
        }
        assert.equal(paths.size, 4);
      }),
  );
});
