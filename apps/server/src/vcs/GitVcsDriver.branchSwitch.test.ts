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
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-branch-switch-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("a branch switch landing after the snapshot belongs to the next checkpoint", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const liveProcess = yield* VcsProcess.VcsProcess;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checkpoint-switch-race-" });
    const git = (args: ReadonlyArray<string>) =>
      driver.execute({ operation: "checkpoint-test", cwd, args });
    yield* git(["init"]);
    yield* git(["config", "user.name", "Test"]);
    yield* git(["config", "user.email", "test@test.com"]);
    yield* fileSystem.writeFileString(path.join(cwd, "f.txt"), "A\n");
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "a"]);
    yield* git(["checkout", "-b", "b"]);
    yield* fileSystem.writeFileString(path.join(cwd, "f.txt"), "B\n");
    yield* git(["commit", "-am", "b"]);
    yield* git(["checkout", "-"]);
    const [first, second, third] = ["1", "2", "3"].map((turn) =>
      CheckpointRef.make(`refs/t3/checkpoints/switch-race/${turn}`),
    ) as [CheckpointRef, CheckpointRef, CheckpointRef];
    const racedDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: Effect.fn(function* (input: VcsProcess.VcsProcessInput) {
          const result = yield* liveProcess.run(input);
          if (input.args.includes("write-tree")) yield* git(["checkout", "b"]).pipe(Effect.orDie);
          return result;
        }),
      }),
    );
    const changedSince = (fromCheckpointRef: CheckpointRef, toCheckpointRef: CheckpointRef) =>
      Effect.gen(function* () {
        const refs = { cwd, fromCheckpointRef, toCheckpointRef };
        return {
          patch: yield* driver.checkpoints.diffCheckpoints({ ...refs, ignoreWhitespace: false }),
          authored: yield* driver.checkpoints.listAuthoredPaths(refs),
        };
      });

    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef: first });
    yield* racedDriver.checkpoints.captureCheckpoint({
      cwd,
      checkpointRef: second,
      previousCheckpointRef: first,
    });
    yield* driver.checkpoints.captureCheckpoint({
      cwd,
      checkpointRef: third,
      previousCheckpointRef: second,
    });

    assert.deepEqual(yield* changedSince(first, second), { patch: "", authored: null });
    assert.deepEqual(yield* changedSince(second, third), { patch: "", authored: null });
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);

// The turn start is a second parent; restore reads the checkpoint's own tree, so it is unchanged.
it.effect("a checkpoint taken after a branch switch restores byte for byte", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const cwd = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-checkpoint-switch-restore-",
    });
    const git = (args: ReadonlyArray<string>) =>
      driver.execute({ operation: "checkpoint-test", cwd, args });
    yield* git(["init"]);
    yield* git(["config", "user.name", "Test"]);
    yield* git(["config", "user.email", "test@test.com"]);
    yield* fileSystem.writeFileString(path.join(cwd, "f.txt"), "A\n");
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "a"]);
    yield* git(["checkout", "-b", "b"]);
    yield* fileSystem.writeFileString(path.join(cwd, "f.txt"), "B\n");
    yield* git(["commit", "-am", "b"]);
    yield* git(["checkout", "-"]);
    const [first, second] = ["1", "2"].map((turn) =>
      CheckpointRef.make(`refs/t3/checkpoints/switch-restore/${turn}`),
    ) as [CheckpointRef, CheckpointRef];
    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef: first });
    yield* git(["checkout", "b"]);
    yield* fileSystem.writeFileString(path.join(cwd, "f.txt"), "edited on b\n");
    yield* fileSystem.writeFileString(path.join(cwd, "new.txt"), "new\n");
    yield* driver.checkpoints.captureCheckpoint({
      cwd,
      checkpointRef: second,
      previousCheckpointRef: first,
    });
    const parents = (yield* git(["rev-list", "--parents", "-n", "1", second])).stdout.trim();
    assert.strictEqual(parents.split(" ").length, 3);

    yield* fileSystem.writeFileString(path.join(cwd, "f.txt"), "later\n");
    yield* fileSystem.remove(path.join(cwd, "new.txt"));
    assert.isTrue(
      yield* driver.checkpoints.restoreCheckpoint({
        cwd,
        checkpointRef: second,
        fallbackToHead: false,
      }),
    );
    assert.strictEqual(yield* fileSystem.readFileString(path.join(cwd, "f.txt")), "edited on b\n");
    assert.strictEqual(yield* fileSystem.readFileString(path.join(cwd, "new.txt")), "new\n");
    const tree = (yield* git(["rev-parse", `${second}^{tree}`])).stdout.trim();
    yield* git(["add", "-A"]);
    assert.strictEqual((yield* git(["write-tree"])).stdout.trim(), tree);
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);
