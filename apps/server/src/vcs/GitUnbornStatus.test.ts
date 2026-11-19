import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { layerTest, makeTmpDir, writeTextFile, git } from "./testing/gitFixture.ts";

it.layer(layerTest)("unborn repository status", (it) => {
  it.effect("counts staged and unstaged edits to a new file once", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* driver.initRepo({ cwd });
      yield* writeTextFile(cwd, "initial.ts", "// first file\n");
      yield* git(cwd, ["add", "initial.ts"]);
      yield* writeTextFile(cwd, "initial.ts", "// edited after staging\n");
      const status = yield* driver.statusDetailsLocal(cwd);
      assert.deepStrictEqual(status.workingTree.files, [
        { path: "initial.ts", insertions: 1, deletions: 0 },
      ]);
    }),
  );
});
