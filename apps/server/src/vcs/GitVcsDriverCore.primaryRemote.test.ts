import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { layerTest, makeTmpDir, git, initRepoWithCommit } from "./testing/gitFixture.ts";

it.effect("marks the default branch of a primary remote that is not named origin", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const remote = yield* makeTmpDir("git-remote-");
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["branch", "-M", "trunk"]);
      yield* git(cwd, ["remote", "add", "upstream", remote]);
      yield* git(cwd, ["push", "upstream", "trunk"]);
      yield* git(cwd, [
        "symbolic-ref",
        "refs/remotes/upstream/HEAD",
        "refs/remotes/upstream/trunk",
      ]);
      yield* git(cwd, ["checkout", "-b", "other"]);
      // "other" sorts ahead of "trunk" by name when their commit times tie.
      yield* git(cwd, ["commit", "--allow-empty", "-m", "newer"]);
      yield* git(cwd, ["checkout", "-b", "feature", "trunk"]);
      const driver = yield* GitVcsDriver.GitVcsDriver;

      const status = yield* driver.statusDetailsLocal(cwd);
      yield* git(cwd, ["checkout", "trunk"]);
      assert.isTrue((yield* driver.statusDetailsLocal(cwd)).isDefaultBranch);
      yield* git(cwd, ["checkout", "feature"]);
      assert.isFalse(status.isDefaultBranch);

      const refs = (yield* driver.listRefs({ cwd, refresh: true, includeMatchingRemoteRefs: true }))
        .refs;
      assert.isTrue(refs.find((ref) => ref.name === "trunk")?.isDefault);
      assert.isTrue(refs.find((ref) => ref.name === "upstream/trunk")?.isDefault);
      const names = refs.map((ref) => ref.name);
      assert.isBelow(names.indexOf("trunk"), names.indexOf("other"));
    }),
  ).pipe(Effect.provide(layerTest)),
);

it.layer(layerTest)("switch remote branches", (it) => {
  it.effect(
    "tracks the real branch name and refuses local collisions for remotes containing slashes",
    () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const slashedRemote = yield* makeTmpDir("git-remote-slashed-");
        yield* git(slashedRemote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "team/origin", slashedRemote]);
        yield* git(cwd, ["push", "team/origin", "HEAD:refs/heads/feature/demo"]);
        yield* git(cwd, ["push", "team/origin", "HEAD:refs/heads/conflict"]);
        yield* git(cwd, ["fetch", "team/origin"]);

        const driver = yield* GitVcsDriver.GitVcsDriver;
        const switched = yield* driver.switchRef({ cwd, refName: "team/origin/feature/demo" });

        assert.equal(switched.refName, "feature/demo");
        assert.equal(yield* git(cwd, ["branch", "--show-current"]), "feature/demo");
        assert.equal(
          yield* git(cwd, ["for-each-ref", "--format=%(upstream)", "refs/heads/feature/demo"]),
          "refs/remotes/team/origin/feature/demo",
        );
        assert.equal(
          yield* git(cwd, ["for-each-ref", "--format=%(refname)", "refs/heads/origin"]),
          "",
        );

        yield* git(cwd, ["checkout", "--no-track", "-b", "conflict"]);
        yield* git(cwd, ["commit", "--allow-empty", "-m", "Local conflict work"]);
        yield* git(cwd, ["checkout", initialBranch]);

        const conflicted = yield* driver
          .switchRef({ cwd, refName: "team/origin/conflict" })
          .pipe(Effect.flip);

        assert.equal(conflicted.reason, "branch_already_exists");
        assert.equal(yield* git(cwd, ["branch", "--show-current"]), initialBranch);
        assert.equal(
          yield* git(cwd, ["for-each-ref", "--format=%(refname)", "refs/heads/origin"]),
          "",
        );
      }),
  );
});
