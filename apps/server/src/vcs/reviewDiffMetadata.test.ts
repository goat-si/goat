import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  git,
  initRepoWithCommit,
  layerTest,
  makeTmpDir,
  writeTextFile,
} from "./testing/gitFixture.ts";

it.layer(layerTest)("review diff metadata", (it) => {
  it.effect("returns complete metadata before file patches for each review scope", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* writeTextFile(cwd, "staged.txt", "staged change\n");
      yield* git(cwd, ["add", "staged.txt"]);
      yield* writeTextFile(cwd, "untracked.txt", "untracked change\n");
      for (const scope of ["working-tree", "staged", "unstaged"] as const) {
        const metadata = yield* driver.getReviewDiffPreview({ cwd, scope, metadataOnly: true });
        const full = yield* driver.getReviewDiffPreview({ cwd, scope });
        assert.deepStrictEqual(metadata.sources[0]?.files, full.sources[0]?.files);
        assert.strictEqual(metadata.sources[0]?.diff, "");
        assert.strictEqual(metadata.sources[0]?.patchesDeferred, true);
        const file = metadata.sources[0]?.files?.[0];
        if (file) {
          const patch = yield* driver.getReviewDiffPreview({
            cwd,
            metadataOnly: true,
            file: { path: file.path, previousPath: file.previousPath, sourceKind: scope },
          });
          assert.include(patch.sources[0]?.diff ?? "", "+");
        }
      }
    }),
  );
});
