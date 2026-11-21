import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  layerTest,
  makeTmpDir,
  git,
  initRepoWithCommit,
  writeTextFile,
} from "./testing/gitFixture.ts";

it.layer(layerTest)("deleted upstreams", (it) => {
  it.effect("republishes a branch whose upstream was deleted", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-remote-");
      yield* initRepoWithCommit(cwd);
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

      yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);

      yield* git(cwd, ["push", "origin", "--delete", "feature/push"]);
      yield* writeTextFile(cwd, "followup.txt", "followup\n");
      yield* git(cwd, ["add", "-A"]);
      yield* (yield* GitVcsDriver.GitVcsDriver).commit(cwd, "Add followup", "");
      const republished = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
      assert.deepInclude(republished, { status: "pushed", branch: "feature/push" });
      assert.equal(
        yield* git(remote, ["--git-dir=.", "rev-parse", "refs/heads/feature/push"]),
        yield* git(cwd, ["rev-parse", "HEAD"]),
      );

      const fork = yield* makeTmpDir("git-fork-");
      yield* git(fork, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "fork", fork]);
      yield* git(cwd, ["remote", "add", "feature", fork]);
      yield* git(cwd, ["push", "-u", "fork", "feature/push"]);
      yield* git(cwd, ["push", "fork", "--delete", "feature/push"]);
      yield* writeTextFile(cwd, "fork.txt", "fork\n");
      yield* git(cwd, ["add", "-A"]);
      yield* (yield* GitVcsDriver.GitVcsDriver).commit(cwd, "Add fork change", "");
      assert.deepInclude(
        yield* (yield* GitVcsDriver.GitVcsDriver).resolvePushTarget(cwd, {
          branch: "feature/push",
          hasUpstream: false,
        }),
        { remoteName: "fork", branchName: "feature/push" },
      );
      const forkRepublished = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(
        cwd,
        null,
      );
      assert.deepInclude(forkRepublished, { upstreamBranch: "fork/feature/push" });
      assert.equal(
        yield* git(fork, ["--git-dir=.", "rev-parse", "refs/heads/feature/push"]),
        yield* git(cwd, ["rev-parse", "HEAD"]),
      );

      yield* git(cwd, ["config", "branch.feature/push.remote", "."]);
      yield* git(cwd, ["config", "branch.feature/push.merge", "refs/heads/push"]);
      yield* writeTextFile(cwd, "local.txt", "local\n");
      yield* git(cwd, ["add", "-A"]);
      yield* (yield* GitVcsDriver.GitVcsDriver).commit(cwd, "Add local change", "");
      const localUpstreamGone = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(
        cwd,
        null,
      );
      assert.deepInclude(localUpstreamGone, { upstreamBranch: "origin/feature/push" });

      yield* git(cwd, ["push", "fork", "HEAD:refs/heads/release"]);
      yield* git(cwd, ["branch", "-u", "fork/release"]);
      yield* git(cwd, ["push", "fork", "--delete", "release"]);
      yield* writeTextFile(cwd, "release.txt", "release\n");
      yield* git(cwd, ["add", "-A"]);
      yield* (yield* GitVcsDriver.GitVcsDriver).commit(cwd, "Add release change", "");
      yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
      assert.equal(
        yield* (yield* GitVcsDriver.GitVcsDriver).readConfigValue(
          cwd,
          "branch.feature/push.t3-merge-base",
        ),
        "release",
      );
    }),
  );
});
