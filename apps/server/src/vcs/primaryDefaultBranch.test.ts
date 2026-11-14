import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { git, initRepoWithCommit, layerTest, makeTmpDir } from "./testing/gitFixture.ts";

it.layer(layerTest)("primary default branch", (it) => {
  it.effect.each(["checkout", "bare-backed worktree"] as const)(
    "uses the only remote's HEAD for default-branch detection without origin in a %s",
    (layout) =>
      Effect.gen(function* () {
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const path = yield* Path.Path;
        const source = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-github-");
        yield* initRepoWithCommit(source);
        yield* git(remote, ["init", "--bare"]);
        yield* git(source, ["branch", "-M", "trunk"]);
        yield* git(source, ["remote", "add", "github", remote]);
        yield* git(source, ["push", "-u", "github", "trunk"]);
        let cwd = source;
        if (layout === "bare-backed worktree") {
          const container = yield* makeTmpDir("git-vcs-driver-bare-");
          const gitDirArgs = ["--git-dir", path.join(container, "repo.git")];
          cwd = path.join(container, "trunk");
          yield* git(container, ["init", "--bare", "repo.git"]);
          yield* git(container, [...gitDirArgs, "config", "user.email", "test@test.com"]);
          yield* git(container, [...gitDirArgs, "config", "user.name", "Test"]);
          yield* git(container, [...gitDirArgs, "remote", "add", "github", remote]);
          yield* git(container, [...gitDirArgs, "fetch", "github"]);
          yield* git(container, [
            ...gitDirArgs,
            "worktree",
            "add",
            "--track",
            "-b",
            "trunk",
            cwd,
            "github/trunk",
          ]);
        }
        yield* git(cwd, ["symbolic-ref", "refs/remotes/github/HEAD", "refs/remotes/github/trunk"]);

        assert.isTrue((yield* driver.statusDetailsLocal(cwd)).isDefaultBranch);
        const remoteStatus = yield* driver.statusDetailsRemote(cwd);
        assert.equal(remoteStatus.defaultBranch, "trunk");
        assert.isTrue(remoteStatus.isDefaultBranch);

        yield* git(cwd, ["remote", "add", "origin", remote]);
        assert.isNull((yield* driver.statusDetailsRemote(cwd)).defaultBranch);
      }),
  );
});
