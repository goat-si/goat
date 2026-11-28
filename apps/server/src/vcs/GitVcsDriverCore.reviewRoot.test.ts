import { assert, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { initRepoWithCommit, layerTest, makeTmpDir, writeTextFile } from "./testing/gitFixture.ts";

it.layer(layerTest)("review diff repository root", (it) => {
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "preserves a trailing space in the repository name",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const cwd = path.join(yield* makeTmpDir(), "repo ");
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "app/.keep", "");
        yield* writeTextFile(cwd, "README.md", "# changed\n");
        const contents = yield* (yield* GitVcsDriver.GitVcsDriver).getReviewDiffFileContents({
          cwd: path.join(cwd, "app"),
          sourceKind: "working-tree",
          changeType: "change",
          baseRef: "HEAD",
          headRef: null,
          oldPath: "README.md",
          newPath: "README.md",
        });
        assert.strictEqual(contents.newContents, "# changed\n");
      }),
  );
});
