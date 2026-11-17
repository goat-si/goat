import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { assert, it } from "@effect/vitest";
import { CheckpointRef } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const layerGitContract = Layer.mergeAll(GitVcsDriver.layerVcs, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-skip-worktree-restore-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeRepo = Effect.fn("makeRepo")(function* (
  driver: Effect.Success<ReturnType<typeof GitVcsDriver.makeVcsDriverShape>>,
  cwd: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = (args: ReadonlyArray<string>) =>
    driver.execute({ operation: "checkpoint-test", cwd, args });
  yield* git(["init"]);
  yield* git(["config", "user.name", "Test"]);
  yield* git(["config", "user.email", "test@test.com"]);
  yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "initial\n");
  yield* git(["add", "."]);
  yield* git(["commit", "-m", "initial"]);
  return { git, checkpointRef: CheckpointRef.make("refs/t3/checkpoints/test") };
});

it.effect("restores edits to skip-worktree files whose checkpoint content matches HEAD", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-skip-worktree-restore-" });
    const { git, checkpointRef } = yield* makeRepo(driver, cwd);
    const skippedPath = path.join(cwd, "skipped.txt");
    yield* fileSystem.writeFileString(skippedPath, "original\n");
    yield* git(["add", "skipped.txt"]);
    yield* git(["commit", "-m", "add skipped file"]);
    yield* git(["update-index", "--skip-worktree", "skipped.txt"]);
    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
    yield* fileSystem.writeFileString(skippedPath, "later\n");

    assert.isTrue(
      yield* driver.checkpoints.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false }),
    );

    assert.strictEqual(yield* fileSystem.readFileString(skippedPath), "original\n");
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

// Edit from here restores hand-flagged files because every turn's capture records them.
it.effect("a later turn's checkpoint holds a hand-flagged file's content at that turn", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-skip-worktree-capture-" });
    const { git } = yield* makeRepo(driver, cwd);
    yield* fileSystem.writeFileString(path.join(cwd, "skipped.txt"), "original\n");
    yield* git(["add", "skipped.txt"]);
    yield* git(["commit", "-m", "add skipped file"]);
    for (const [flag, turn] of [
      ["--skip-worktree", "first"],
      ["--assume-unchanged", "second"],
    ] as const) {
      yield* git(["update-index", "--no-skip-worktree", "--no-assume-unchanged", "skipped.txt"]);
      yield* git(["update-index", flag, "skipped.txt"]);
      yield* fileSystem.writeFileString(path.join(cwd, "skipped.txt"), `${turn} turn\n`);
      const checkpointRef = CheckpointRef.make(`refs/t3/checkpoints/${turn}`);
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
      const shown = yield* git(["show", `${checkpointRef}:skipped.txt`]);
      assert.strictEqual(shown.stdout, `${turn} turn\n`);
    }
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

it.effect("sparse restore rewrites manual skip-worktree files and keeps exclusions absent", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const liveProcess = yield* VcsProcess.VcsProcess;
    // One byte per chunk, so the index listing splits inside every record.
    const driver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: (input) => {
          const onStdoutChunk = input.onStdoutChunk;
          return liveProcess.run(
            onStdoutChunk === undefined
              ? input
              : {
                  ...input,
                  onStdoutChunk: (chunk) => {
                    for (let index = 0; index < chunk.length; index++)
                      onStdoutChunk(chunk.subarray(index, index + 1));
                  },
                },
          );
        },
      }),
    );
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sparse-restore-" });
    const { git, checkpointRef } = yield* makeRepo(driver, cwd);
    for (const name of ["in/normal", "in/skipped", "in/s space", "out/deep/absent", "out/stray"]) {
      yield* fs.makeDirectory(path.dirname(path.join(cwd, name)), { recursive: true });
      yield* fs.writeFileString(path.join(cwd, name), "original\n");
    }
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "sparse fixture"]);
    yield* git(["sparse-checkout", "set", "--cone", "--sparse-index", "in"]);
    // Keeps Git from clearing the bit on files that are present.
    yield* git(["config", "sparse.expectFilesOutsideOfPatterns", "true"]);
    yield* git(["update-index", "--skip-worktree", "in/skipped", "in/s space"]);
    const captureCwd = path.join(cwd, "in");
    yield* driver.checkpoints.captureCheckpoint({ cwd: captureCwd, checkpointRef });
    yield* fs.writeFileString(path.join(cwd, "in/skipped"), "later\n");
    yield* fs.writeFileString(path.join(cwd, "in/s space"), "later\n");
    yield* fs.writeFileString(path.join(cwd, "in/normal"), "later\n");

    for (const restoreCwd of [captureCwd, cwd]) {
      assert.isTrue(
        yield* driver.checkpoints.restoreCheckpoint({
          cwd: restoreCwd,
          checkpointRef,
          fallbackToHead: false,
        }),
      );
      assert.strictEqual(yield* fs.readFileString(path.join(cwd, "in/skipped")), "original\n");
      assert.strictEqual(yield* fs.readFileString(path.join(cwd, "in/s space")), "original\n");
      assert.strictEqual(yield* fs.readFileString(path.join(cwd, "in/normal")), "original\n");
      assert.isFalse(yield* fs.exists(path.join(cwd, "out")));
    }
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);
