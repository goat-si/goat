import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  git,
  initRepoWithCommit,
  layerTest,
  layerServerConfig,
  makeTmpDir,
  writeTextFile,
} from "./testing/gitFixture.ts";

it.layer(layerTest)("review diff metadata", (it) => {
  it.effect("changes the metadata hash when changed content keeps the same line counts", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* writeTextFile(cwd, "changed.txt", "original\n");
      yield* git(cwd, ["add", "changed.txt"]);
      yield* git(cwd, ["commit", "-m", "add file"]);
      yield* writeTextFile(cwd, "changed.txt", "first content\n");
      const first = yield* driver.getReviewDiffPreview({
        cwd,
        scope: "working-tree",
        metadataOnly: true,
      });
      yield* writeTextFile(cwd, "changed.txt", "other content\n");
      const second = yield* driver.getReviewDiffPreview({
        cwd,
        scope: "working-tree",
        metadataOnly: true,
      });
      assert.deepStrictEqual(first.sources[0]?.files, second.sources[0]?.files);
      assert.notStrictEqual(first.sources[0]?.diffHash, second.sources[0]?.diffHash);
    }),
  );

  it.effect("marks tracked-only metadata incomplete until untracked files are prepared", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* writeTextFile(cwd, "README.md", "tracked update\n");
      yield* writeTextFile(cwd, "new.txt", "untracked update\n");
      for (const scope of ["working-tree", "unstaged"] as const) {
        const tracked = yield* driver.getReviewDiffPreview({
          cwd,
          scope,
          metadataOnly: true,
          trackedOnly: true,
        });
        assert.strictEqual(tracked.incomplete, true);
        assert.deepStrictEqual(
          tracked.sources[0]?.files?.map((file) => file.path),
          ["README.md"],
        );
        const complete = yield* driver.getReviewDiffPreview({ cwd, scope, metadataOnly: true });
        assert.isUndefined(complete.incomplete);
        assert.deepStrictEqual(complete.sources[0]?.files?.map((file) => file.path).sort(), [
          "README.md",
          "new.txt",
        ]);
      }
    }),
  );

  it.effect("returns tracked metadata while untracked discovery is blocked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "README.md", "tracked update\n");
        yield* writeTextFile(cwd, "new.txt", "untracked update\n");
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = ChildProcessSpawner.make((command) => {
          if (
            ChildProcess.isStandardCommand(command) &&
            command.args[0] === "ls-files" &&
            command.args[1] === "--others"
          ) {
            return Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(delegate.spawn(command)),
            );
          }
          return delegate.spawn(command);
        });
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(layerServerConfig),
        );
        const complete = yield* driver
          .getReviewDiffPreview({ cwd, scope: "working-tree", metadataOnly: true })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const tracked = yield* driver.getReviewDiffPreview({
          cwd,
          scope: "working-tree",
          metadataOnly: true,
          trackedOnly: true,
        });
        assert.strictEqual(tracked.incomplete, true);
        assert.deepStrictEqual(
          tracked.sources[0]?.files?.map((file) => file.path),
          ["README.md"],
        );
        assert.isFalse(yield* Deferred.isDone(release));
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(complete);
        assert.deepStrictEqual(result.sources[0]?.files?.map((file) => file.path).sort(), [
          "README.md",
          "new.txt",
        ]);
      }),
    ),
  );

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
