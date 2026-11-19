import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  git,
  initRepoWithCommit,
  layerTest,
  makeTmpDir,
  writeTextFile,
} from "./testing/gitFixture.ts";

it.effect("reports added and deleted file types before patches load", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    yield* initRepoWithCommit(cwd);
    yield* writeTextFile(cwd, "added.txt", "new\n");
    yield* git(cwd, ["add", "added.txt"]);
    yield* git(cwd, ["rm", "README.md"]);
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const source = (yield* driver.getReviewDiffPreview({
      cwd,
      scope: "staged",
      metadataOnly: true,
    })).sources[0];
    assert.deepStrictEqual(
      source?.files?.map(({ path, changeType }) => [path, changeType]).sort(),
      [
        ["README.md", "deleted"],
        ["added.txt", "new"],
      ],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reports committed renames and unstaged additions and deletions", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    const { initialBranch } = yield* initRepoWithCommit(cwd);
    yield* git(cwd, ["checkout", "-b", "feature"]);
    yield* git(cwd, ["mv", "README.md", "renamed.md"]);
    yield* git(cwd, ["commit", "-m", "rename"]);
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const branch = (yield* driver.getReviewDiffPreview({
      cwd,
      scope: "branch-range",
      baseRef: initialBranch,
      metadataOnly: true,
    })).sources[0];
    assert.deepStrictEqual(
      branch?.files?.map(({ path, previousPath, changeType }) => [path, previousPath, changeType]),
      [["renamed.md", "README.md", "rename-pure"]],
    );
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.remove(path.join(cwd, "renamed.md"));
    yield* writeTextFile(cwd, "new.txt", "new\n");
    const unstaged = (yield* driver.getReviewDiffPreview({
      cwd,
      scope: "unstaged",
      metadataOnly: true,
    })).sources[0];
    assert.isTrue(
      unstaged?.files?.some((file) => file.path === "new.txt" && file.changeType === "new"),
    );
    assert.isTrue(
      unstaged?.files?.some((file) => file.path === "renamed.md" && file.changeType === "deleted"),
    );
  }).pipe(Effect.provide(layerTest)),
);
