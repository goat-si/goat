import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  layerTest,
  makeTmpDir,
  writeTextFile,
  git,
  initRepoWithCommit,
} from "./testing/gitFixture.ts";

it.layer(layerTest)("configured push remote", (it) => {
  it.effect.each(["branch.topic.pushRemote", "remote.pushDefault"] as const)(
    "pushes a branch tracking its upstream head to the %s remote",
    (configKey) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const upstreamRemote = yield* makeTmpDir("git-upstream-remote-");
        const forkRemote = yield* makeTmpDir("git-fork-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(upstreamRemote, ["init", "--bare"]);
        yield* git(forkRemote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "upstream", upstreamRemote]);
        yield* git(cwd, ["remote", "add", "fork", forkRemote]);
        yield* git(cwd, ["checkout", "-b", "topic"]);
        yield* git(cwd, ["push", "upstream", "topic"]);
        yield* git(cwd, ["push", "fork", "topic"]);
        yield* git(cwd, ["branch", "--set-upstream-to=upstream/topic"]);
        yield* git(cwd, ["config", configKey, "fork"]);
        const upstreamTopicSha = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* writeTextFile(cwd, "fork.txt", "fork\n");
        yield* git(cwd, ["add", "-A"]);
        yield* driver.commit(cwd, "Add fork update", "");

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "topic",
          upstreamBranch: "fork/topic",
          pushRemote: "fork",
          setUpstream: false,
        });
        assert.equal(
          yield* git(forkRemote, ["--git-dir=.", "log", "-1", "--pretty=%s", "topic"]),
          "Add fork update",
        );
        assert.equal(
          yield* git(upstreamRemote, ["--git-dir=.", "rev-parse", "topic"]),
          upstreamTopicSha,
        );
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
          "upstream/topic",
        );
      }),
  );

  it.effect.each(["deleted", "rewound"] as const)(
    "pushes an up-to-date tracked branch to the push remote when its branch there is %s",
    (forkState) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const upstreamRemote = yield* makeTmpDir("git-upstream-remote-");
        const forkRemote = yield* makeTmpDir("git-fork-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(upstreamRemote, ["init", "--bare"]);
        yield* git(forkRemote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "upstream", upstreamRemote]);
        yield* git(cwd, ["remote", "add", "fork", forkRemote]);
        yield* git(cwd, ["checkout", "-b", "topic"]);
        yield* writeTextFile(cwd, "upstream.txt", "upstream\n");
        yield* git(cwd, ["add", "-A"]);
        yield* driver.commit(cwd, "Add upstream update", "");
        yield* git(cwd, ["push", "-u", "upstream", "topic"]);
        yield* git(cwd, ["config", "remote.pushDefault", "fork"]);
        // Another checkout changes the fork after this one last fetched it,
        // leaving a local fork/topic that still contains HEAD.
        yield* git(cwd, ["push", "fork", "topic"]);
        yield* git(
          forkRemote,
          forkState === "deleted"
            ? ["--git-dir=.", "update-ref", "-d", "refs/heads/topic"]
            : ["--git-dir=.", "update-ref", "refs/heads/topic", "topic~1"],
        );

        const pushed = yield* driver.pushCurrentBranch(cwd, null);

        assert.deepInclude(pushed, {
          status: "pushed",
          upstreamBranch: "fork/topic",
          pushRemote: "fork",
        });
        assert.equal(
          yield* git(forkRemote, ["--git-dir=.", "log", "-1", "--pretty=%s", "topic"]),
          "Add upstream update",
        );
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
          "upstream/topic",
        );
      }),
  );

  it.effect("skips an up-to-date tracked branch the push remote already has", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const upstreamRemote = yield* makeTmpDir("git-upstream-remote-");
      const forkRemote = yield* makeTmpDir("git-fork-remote-");
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(upstreamRemote, ["init", "--bare"]);
      yield* git(forkRemote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "upstream", upstreamRemote]);
      yield* git(cwd, ["remote", "add", "fork", forkRemote]);
      yield* git(cwd, ["checkout", "-b", "topic"]);
      yield* git(cwd, ["push", "-u", "upstream", "topic"]);
      yield* git(cwd, ["push", "fork", "topic"]);
      yield* git(cwd, ["config", "remote.pushDefault", "fork"]);

      const pushed = yield* driver.pushCurrentBranch(cwd, null);

      assert.deepInclude(pushed, {
        status: "skipped_up_to_date",
        upstreamBranch: "fork/topic",
        pushRemote: "fork",
      });
    }),
  );

  it.effect("skips an up-to-date branch whose differently named upstream is its base", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const upstreamRemote = yield* makeTmpDir("git-upstream-remote-");
      const forkRemote = yield* makeTmpDir("git-fork-remote-");
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(upstreamRemote, ["init", "--bare"]);
      yield* git(forkRemote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "upstream", upstreamRemote]);
      yield* git(cwd, ["remote", "add", "fork", forkRemote]);
      yield* git(cwd, ["push", "upstream", "HEAD:refs/heads/release"]);
      yield* git(cwd, ["fetch", "upstream"]);
      yield* git(cwd, ["checkout", "-b", "topic", "--track", "upstream/release"]);
      yield* git(cwd, ["config", "remote.pushDefault", "fork"]);

      const pushed = yield* driver.pushCurrentBranch(cwd, null);

      assert.deepInclude(pushed, {
        status: "skipped_up_to_date",
        upstreamBranch: "upstream/release",
      });
      assert.equal(yield* git(forkRemote, ["--git-dir=.", "branch", "--list", "topic"]), "");
    }),
  );
});
