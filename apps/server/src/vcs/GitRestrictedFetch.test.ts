import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { layerTest, makeTmpDir, git, initRepoWithCommit } from "./testing/gitFixture.ts";

it.layer(layerTest)("restricted fetch mappings", (it) => {
  it.effect.each([
    {
      configuration: "ordinary",
      fetchRefspecs: ["+refs/heads/*:refs/remotes/origin/*"],
      addsMapping: false,
    },
    {
      configuration: "restricted",
      fetchRefspecs: [
        "+refs/heads/main:refs/remotes/origin/main",
        "+refs/heads/team/*:refs/remotes/origin/team/*",
        "+refs/heads/release/release-*:refs/remotes/origin/release/release-*",
      ],
      addsMapping: true,
    },
  ])(
    "sets a fetched branch's upstream with $configuration fetch configuration",
    ({ fetchRefspecs, addsMapping }) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const remote = yield* makeTmpDir("git-remote-");
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["config", "--unset-all", "remote.origin.fetch"]);
        for (const refspec of fetchRefspecs) {
          yield* git(cwd, ["config", "--add", "remote.origin.fetch", refspec]);
        }
        const remoteBranch = "feature/example-change";
        const branch = "review/example-change";
        const mapping = `+refs/heads/${remoteBranch}*:refs/remotes/origin/${remoteBranch}*`;
        yield* git(cwd, [
          "push",
          remote,
          "HEAD:refs/heads/main",
          `HEAD:refs/heads/${remoteBranch}`,
        ]);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.fetchRemoteTrackingBranch({ cwd, remoteName: "origin", remoteBranch });
        yield* git(cwd, ["checkout", "--no-track", "-b", branch, `origin/${remoteBranch}`]);

        const input = { cwd, branch, remoteName: "origin", remoteBranch };
        yield* driver.setBranchUpstream(input);
        yield* driver.setBranchUpstream(input);

        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]),
          `origin/${remoteBranch}`,
        );
        assert.equal(yield* git(cwd, ["config", `branch.${branch}.remote`]), "origin");
        assert.equal(
          yield* git(cwd, ["config", `branch.${branch}.merge`]),
          `refs/heads/${remoteBranch}`,
        );
        assert.deepEqual(
          (yield* git(cwd, ["config", "--get-all", "remote.origin.fetch"])).split("\n"),
          addsMapping ? [...fetchRefspecs, mapping] : fetchRefspecs,
        );
        // A merged PR's head is deleted; later fetches of the remote must keep working.
        yield* git(remote, ["--git-dir", remote, "branch", "-D", remoteBranch]);
        yield* git(cwd, ["fetch", "origin"]);
      }),
  );
});
