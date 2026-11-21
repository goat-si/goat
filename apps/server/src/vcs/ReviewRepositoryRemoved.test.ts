import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { initRepoWithCommit, layerTest, makeTmpDir, writeTextFile } from "./testing/gitFixture.ts";

it.effect("does not use a cached review layout after the repository is removed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      yield* writeTextFile(cwd, "change.txt", "new\n");
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* driver.getReviewDiffPreview({ cwd });
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.remove(path.join(cwd, ".git"), { recursive: true });
      assert.isEmpty((yield* driver.getReviewDiffPreview({ cwd })).sources);
      assert.isEmpty((yield* driver.getReviewDiffPreview({ cwd, scope: "working-tree" })).sources);
    }),
  ).pipe(Effect.provide(layerTest)),
);
