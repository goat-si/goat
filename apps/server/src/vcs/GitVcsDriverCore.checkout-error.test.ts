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

it.layer(layerTest)("checkout errors", (it) => {
  it.effect("explains how to proceed when local changes block a branch switch", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* writeTextFile(cwd, "example.txt", "main\n");
      yield* git(cwd, ["add", "example.txt"]);
      yield* git(cwd, ["commit", "-m", "main example"]);
      yield* git(cwd, ["checkout", "-q", "-b", "feature"]);
      yield* writeTextFile(cwd, "example.txt", "feature\n");
      yield* git(cwd, ["commit", "-am", "feature example"]);
      yield* git(cwd, ["checkout", "-q", initialBranch]);
      yield* writeTextFile(cwd, "example.txt", "uncommitted work\n");

      const error = yield* driver.switchRef({ cwd, refName: "feature" }).pipe(Effect.flip);

      assert.match(error.detail, /local changes/i);
      assert.match(error.detail, /commit|stash|discard/i);
      assert.equal(yield* git(cwd, ["branch", "--show-current"]), initialBranch);
    }),
  );
});
