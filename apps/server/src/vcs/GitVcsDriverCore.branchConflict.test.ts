import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { layerTest, makeTmpDir, git, initRepoWithCommit } from "./testing/gitFixture.ts";

it.layer(layerTest)("worktree branch conflicts", (it) => {
  it.effect("explains a new branch that collides with an existing branch namespace", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["branch", "werkstatt"]);
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const error = yield* driver
        .createWorktree({
          cwd,
          path: path.join(yield* makeTmpDir("git-worktrees-"), "conflict"),
          refName: initialBranch,
          newRefName: "werkstatt/baseline",
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "GitCommandError");
      assert.equal(error.reason, "ref_name_conflict");
    }),
  );
});
