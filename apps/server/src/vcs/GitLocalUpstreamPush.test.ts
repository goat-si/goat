import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  git,
  initRepoWithCommit,
  layerTest,
  makeTmpDir,
  writeTextFile,
} from "./testing/gitFixture.ts";

it.layer(layerTest)("publish locally tracked branches", (it) => {
  it.effect.each([
    { baseBranch: "dev", local: false },
    { baseBranch: "dev", local: true },
    { baseBranch: "feature/base", local: true },
    { baseBranch: "upstream", local: true },
    { baseBranch: "upstream/feature/x", local: true },
  ])(
    "publishes a branch tracking $baseBranch (local=$local) under its own name, not the base",
    ({ baseBranch, local }) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const upstream = yield* makeTmpDir("git-upstream-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", "main"]);
        yield* git(cwd, ["checkout", "--no-track", "-b", baseBranch]);
        yield* git(cwd, ["push", "-u", "origin", baseBranch]);
        const devSha = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(upstream, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "upstream", upstream]);
        yield* writeTextFile(cwd, "upstream.txt", "upstream work\n");
        yield* git(cwd, ["add", "-A"]);
        yield* driver.commit(cwd, "Add upstream update", "");
        yield* git(cwd, ["push", "upstream", baseBranch]);
        const upstreamDevSha = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, [
          "checkout",
          "--track",
          "-b",
          "feature/x",
          local ? `refs/heads/${baseBranch}` : `refs/remotes/upstream/${baseBranch}`,
        ]);
        assert.equal(
          yield* driver.readConfigValue(cwd, "branch.feature/x.remote"),
          local ? "." : "upstream",
        );
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "-A"]);
        yield* driver.commit(cwd, "Add feature", "");

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/x",
          upstreamBranch: "origin/feature/x",
          setUpstream: true,
        });
        assert.equal(
          yield* git(remote, ["--git-dir=.", "log", "-1", "--pretty=%s", "feature/x"]),
          "Add feature",
        );
        assert.equal(
          yield* git(remote, ["--git-dir=.", "rev-parse", `refs/heads/${baseBranch}`]),
          devSha,
        );
        assert.equal(
          yield* git(upstream, ["--git-dir=.", "rev-parse", `refs/heads/${baseBranch}`]),
          upstreamDevSha,
        );
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
          "origin/feature/x",
        );
        assert.equal(
          yield* driver.readConfigValue(cwd, "branch.feature/x.t3-merge-base"), // goat-rename: legacy
          baseBranch,
        );
        assert.equal(
          yield* driver.readConfigValue(cwd, "branch.feature/x.t3-merge-base-ref"), // goat-rename: legacy
          local ? `refs/heads/${baseBranch}` : `refs/remotes/upstream/${baseBranch}`,
        );
        assert.equal(yield* git(cwd, ["rev-parse", `refs/heads/${baseBranch}`]), upstreamDevSha);

        const preview = yield* driver.getReviewDiffPreview({ cwd });
        const changes = preview.sources.find((source) => source.kind === "branch-range")!;
        assert.deepStrictEqual(changes.files, [
          { path: "feature.txt", previousPath: null, additions: 1, deletions: 0 },
        ]);
        assert.equal(
          changes.baseRef,
          local ? `refs/heads/${baseBranch}` : `upstream/${baseBranch}`,
        );
      }),
  );

  it.effect.each([
    { upstreamRef: "refs/remotes/origin/main", baseKey: "gh-merge-base" },
    { upstreamRef: "refs/heads/main", baseKey: "gh-merge-base" },
    { upstreamRef: "refs/heads/main", baseKey: "t3-merge-base" }, // goat-rename: legacy
  ])(
    "keeps a recorded $baseKey when publishing a branch tracking $upstreamRef",
    ({ upstreamRef, baseKey }) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", "main"]);
        yield* git(cwd, ["checkout", "--track", "-b", "feature/y", upstreamRef]);
        yield* git(cwd, ["config", `branch.feature/y.${baseKey}`, "release/v2"]);
        yield* git(cwd, [
          "config",
          "branch.feature/y.t3-merge-base-ref", // goat-rename: legacy
          "refs/heads/release/v2",
        ]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "-A"]);
        yield* driver.commit(cwd, "Add feature", "");

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/y",
          upstreamBranch: "origin/feature/y",
          setUpstream: true,
        });
        assert.equal(
          yield* driver.readConfigValue(cwd, `branch.feature/y.${baseKey}`),
          "release/v2",
        );
        assert.equal(yield* driver.readBranchBase(cwd, "feature/y"), "release/v2");
        assert.equal(
          yield* driver.readConfigValue(cwd, "branch.feature/y.t3-merge-base-ref"), // goat-rename: legacy
          "refs/heads/release/v2",
        );
      }),
  );

  it.effect.each(["main", "feature/base"])(
    "rejects publishing a branch tracking local %s without a git remote",
    (parent) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", parent]);
        yield* git(cwd, ["checkout", "--track", "-b", "child", `refs/heads/${parent}`]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "-A"]);
        yield* driver.commit(cwd, "Add feature", "");
        const parentSha = yield* git(cwd, ["rev-parse", `refs/heads/${parent}`]);

        const error = yield* driver.pushCurrentBranch(cwd, null).pipe(Effect.flip);

        assert.equal(error._tag, "GitCommandError");
        assert.equal(error.operation, "GitVcsDriver.pushCurrentBranch");
        assert.equal(
          error.detail,
          "Cannot push because no git remote is configured for this repository.",
        );
        assert.equal(yield* git(cwd, ["rev-parse", `refs/heads/${parent}`]), parentSha);
      }),
  );

  it.effect("publishes a local-tracking branch named like a remote ref under its full name", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-remote-");
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(cwd, ["branch", "-M", "main"]);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "-u", "origin", "main"]);
      const mainSha = yield* git(cwd, ["rev-parse", "refs/heads/main"]);
      yield* git(cwd, ["checkout", "--track", "-b", "origin/main", "refs/heads/main"]);
      yield* writeTextFile(cwd, "feature.txt", "feature\n");
      yield* git(cwd, ["add", "-A"]);
      yield* driver.commit(cwd, "Add feature", "");

      const pushed = yield* driver.pushCurrentBranch(cwd, null);

      assert.deepInclude(pushed, {
        status: "pushed",
        branch: "origin/main",
        upstreamBranch: "origin/origin/main",
      });
      assert.equal(yield* git(remote, ["--git-dir=.", "rev-parse", "refs/heads/main"]), mainSha);
      assert.equal(
        yield* git(remote, ["--git-dir=.", "log", "-1", "--pretty=%s", "refs/heads/origin/main"]),
        "Add feature",
      );
    }),
  );

  it.effect.each([false, true])(
    "pushes with upstream setup and skips when already up to date (autoSetupMerge=%s)",
    (autoSetupMerge) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        if (autoSetupMerge) {
          yield* git(cwd, ["config", "branch.autoSetupMerge", "always"]);
        }
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* (yield* GitVcsDriver.GitVcsDriver).createRef({
          cwd,
          refName: "feature/push",
        });
        yield* (yield* GitVcsDriver.GitVcsDriver).switchRef({
          cwd,
          refName: "feature/push",
        });
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "-A"]);
        yield* (yield* GitVcsDriver.GitVcsDriver).commit(cwd, "Add feature", "");

        const driver = yield* GitVcsDriver.GitVcsDriver;
        if (autoSetupMerge) {
          assert.equal(yield* driver.readConfigValue(cwd, "branch.feature/push.remote"), ".");
          assert.equal(
            yield* driver.readConfigValue(cwd, "branch.feature/push.merge"),
            `refs/heads/${initialBranch}`,
          );
        }

        const pushed = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/push",
          setUpstream: true,
        });
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
          "origin/feature/push",
        );

        if (autoSetupMerge) {
          assert.equal(
            yield* driver.readConfigValue(cwd, "branch.feature/push.t3-merge-base"), // goat-rename: legacy
            initialBranch,
          );
          assert.equal(
            yield* driver.readConfigValue(cwd, "branch.feature/push.t3-merge-base-ref"), // goat-rename: legacy
            `refs/heads/${initialBranch}`,
          );
        }

        const skipped = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
        assert.deepInclude(skipped, {
          status: "skipped_up_to_date",
          branch: "feature/push",
        });
      }),
  );
});
