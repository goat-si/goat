import { assert, it } from "@effect/vitest";
import { CheckpointRef } from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { git } from "./testing/gitFixture.ts";

const layerTest = Layer.mergeAll(GitVcsDriver.layerVcs, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-git-vcs-contract-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("restores a checkpoint before the first commit without staging its files", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    for (const nested of [false, true]) {
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-unborn-restore-" });
      yield* git(root, ["init"]);
      yield* git(root, ["config", "user.email", "test@test.com"]);
      yield* git(root, ["config", "user.name", "Test"]);
      if (nested) {
        yield* fileSystem.writeFileString(path.join(root, "outside.txt"), "staged\n");
        yield* git(root, ["add", "outside.txt"]);
      }
      const cwd = nested ? path.join(root, "nested") : root;
      yield* fileSystem.makeDirectory(cwd, { recursive: true });
      yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "original\n");
      const checkpointRef = CheckpointRef.make("refs/goat/checkpoints/unborn");
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
      yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "changed\n");
      yield* fileSystem.writeFileString(path.join(cwd, "added.txt"), "new\n");

      assert.isTrue(
        yield* driver.checkpoints.restoreCheckpoint({ cwd, checkpointRef, fallbackToHead: false }),
      );

      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(cwd, "file.txt")),
        "original\n",
      );
      assert.isFalse(yield* fileSystem.exists(path.join(cwd, "added.txt")));
      const staged = yield* driver.execute({
        operation: "test",
        cwd: root,
        args: ["diff", "--cached", "--name-only"],
      });
      assert.strictEqual(staged.stdout.trim(), nested ? "outside.txt" : "");
    }
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

const makeCheckpointFixture = Effect.fn("makeCheckpointFixture")(function* (
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
  const checkpointRef = CheckpointRef.make("refs/goat/checkpoints/test");
  yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "staged\n");
  yield* git(["add", "."]);
  yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "unstaged\n");
  return { git, checkpointRef };
});

it.effect("checkpoint capture keeps LF files that core.safecrlf would refuse to commit", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-checkpoint-safecrlf-" });
    const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
    yield* fileSystem.writeFileString(path.join(cwd, ".gitattributes"), "*.txt text eol=crlf\n");
    yield* git(["config", "core.safecrlf", "true"]);
    yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), "ignored.txt\n");
    yield* fileSystem.writeFileString(path.join(cwd, "ignored.txt"), "staged\n");
    yield* git(["-c", "core.safecrlf=false", "add", "-f", "ignored.txt"]);
    yield* fileSystem.writeFileString(path.join(cwd, "ignored.txt"), "staged and edited\n");
    yield* fileSystem.writeFileString(path.join(cwd, "untracked.txt"), "new\n");
    const originalIndex = yield* fileSystem.readFile(path.join(cwd, ".git", "index"));

    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

    assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "unstaged\n");
    assert.strictEqual((yield* git(["show", `${checkpointRef}:untracked.txt`])).stdout, "new\n");
    assert.strictEqual(
      (yield* git(["show", `${checkpointRef}:ignored.txt`])).stdout,
      "staged and edited\n",
    );
    assert.deepEqual(yield* fileSystem.readFile(path.join(cwd, ".git", "index")), originalIndex);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
