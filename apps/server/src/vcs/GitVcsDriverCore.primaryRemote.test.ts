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
