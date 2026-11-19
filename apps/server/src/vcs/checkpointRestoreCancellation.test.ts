import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { assert, it } from "@effect/vitest";
import { CheckpointRef } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const layerServerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "goat-restore-cancel-" });
const layerGitContract = Layer.mergeAll(GitVcsDriver.layerVcs, GitVcsDriver.layer).pipe(
  Layer.provide(layerServerConfig),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
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
  const checkpointRef = CheckpointRef.make("refs/t3/checkpoints/test");
  yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "staged\n");
  yield* git(["add", "."]);
  yield* fileSystem.writeFileString(path.join(cwd, "file.txt"), "unstaged\n");
  return { git, checkpointRef };
});

it.effect.each([
  { stop: "before git restore spawns", gate: "restore", index: "staged", file: "later\n" },
  { stop: "after git restore ran", gate: "clean", index: "head", file: "unstaged\n" },
] as const)(
  "checkpoint restore interrupted $stop leaves the $index index",
  ({ gate, index, file }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const liveProcess = yield* VcsProcess.VcsProcess;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-restore-interrupt-" });
      const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });
      yield* fs.writeFileString(path.join(cwd, "file.txt"), "later\n");
      yield* git(["add", "file.txt"]);
      const stagedTree = (yield* git(["write-tree"])).stdout;
      const entered = yield* Deferred.make<void>();
      const gatedDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
        Effect.provideService(VcsProcess.VcsProcess, {
          run: (input) =>
            input.operation === "GitVcsDriver.checkpoints.restoreCheckpoint" &&
            input.args.includes(gate)
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
              : liveProcess.run(input),
        }),
      );
      const fiber = yield* gatedDriver.checkpoints
        .restoreCheckpoint({ cwd, checkpointRef })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      const result = yield* Fiber.await(fiber);
      assert.isTrue(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause));

      assert.strictEqual(
        (yield* git(["write-tree"])).stdout,
        index === "head" ? (yield* git(["rev-parse", "HEAD^{tree}"])).stdout : stagedTree,
      );
      assert.strictEqual(yield* fs.readFileString(path.join(cwd, "file.txt")), file);
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);
