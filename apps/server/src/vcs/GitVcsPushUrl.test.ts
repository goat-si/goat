import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { layerTest, makeTmpDir, git, initRepoWithCommit } from "./testing/gitFixture.ts";

it.layer(layerTest)("push destination URLs", (it) => {
  it.effect("publishes to every configured push URL even when the fetch remote has HEAD", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const upstream = yield* makeTmpDir("git-upstream-");
      const fork = yield* makeTmpDir("git-fork-");
      const mirror = yield* makeTmpDir("git-mirror-");
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      for (const dir of [upstream, fork, mirror]) yield* git(dir, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "upstream", upstream]);
      yield* git(cwd, ["remote", "add", "fork", fork]);
      yield* git(cwd, ["checkout", "-b", "topic"]);
      yield* git(cwd, ["push", "-u", "upstream", "topic"]);
      yield* git(cwd, ["push", "fork", "topic"]);
      yield* git(cwd, ["config", "remote.pushDefault", "fork"]);
      yield* git(cwd, ["remote", "set-url", "--add", "--push", "fork", fork]);
      yield* git(cwd, ["remote", "set-url", "--add", "--push", "fork", mirror]);
      assert.deepInclude(yield* driver.pushCurrentBranch(cwd, null), {
        status: "pushed",
        pushRemote: "fork",
      });
      assert.equal(
        yield* git(mirror, ["--git-dir=.", "rev-parse", "refs/heads/topic"]),
        yield* git(cwd, ["rev-parse", "HEAD"]),
      );
    }),
  );
  it.effect("pushes an up-to-date branch when the tracked remote uses a different push URL", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const fetchRemote = yield* makeTmpDir("git-fetch-remote-");
      const pushRemote = yield* makeTmpDir("git-push-remote-");
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(fetchRemote, ["init", "--bare"]);
      yield* git(pushRemote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", fetchRemote]);
      yield* git(cwd, ["checkout", "-b", "topic"]);
      yield* git(cwd, ["push", "-u", "origin", "topic"]);
      yield* git(cwd, ["remote", "set-url", "--push", "origin", pushRemote]);
      const pushed = yield* driver.pushCurrentBranch(cwd, null);
      assert.deepInclude(pushed, { status: "pushed", upstreamBranch: "origin/topic" });
      assert.equal(
        yield* git(pushRemote, ["--git-dir=.", "rev-parse", "refs/heads/topic"]),
        yield* git(cwd, ["rev-parse", "HEAD"]),
      );
    }),
  );
});
