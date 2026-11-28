import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { assert, it } from "@effect/vitest";
import { CheckpointRef } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const layerGitContract = Layer.mergeAll(GitVcsDriver.layerVcs, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-checkpoint-test-" })),
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

// Root reads mode-000 files, so the permission failure only exists for other users.
it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32" || process.getuid?.() === 0)(
  "checkpoint capture keeps the indexed version of files it cannot read",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.makeVcsDriverShape();
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "goat-checkpoint-unreadable-",
      });
      const { git, checkpointRef } = yield* makeCheckpointFixture(driver, cwd);
      yield* fileSystem.writeFileString(path.join(cwd, "locked.txt"), "committed\n");
      yield* git(["add", "locked.txt"]);
      yield* git(["commit", "-m", "locked"]);
      yield* fileSystem.writeFileString(path.join(cwd, "locked.txt"), "changed\n");
      yield* fileSystem.writeFileString(path.join(cwd, "secret.txt"), "untracked\n");
      yield* fileSystem.writeFileString(path.join(cwd, "untracked.txt"), "new\n");
      yield* Effect.acquireRelease(
        Effect.all([
          fileSystem.chmod(path.join(cwd, "locked.txt"), 0),
          fileSystem.chmod(path.join(cwd, "secret.txt"), 0),
        ]),
        () =>
          Effect.all([
            fileSystem.chmod(path.join(cwd, "locked.txt"), 0o644),
            fileSystem.chmod(path.join(cwd, "secret.txt"), 0o644),
          ]).pipe(Effect.orDie),
      );

      yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef });

      assert.strictEqual((yield* git(["show", `${checkpointRef}:file.txt`])).stdout, "unstaged\n");
      assert.strictEqual((yield* git(["show", `${checkpointRef}:untracked.txt`])).stdout, "new\n");
      assert.strictEqual(
        (yield* git(["show", `${checkpointRef}:locked.txt`])).stdout,
        "committed\n",
      );
      assert.strictEqual((yield* git(["ls-tree", checkpointRef, "--", "secret.txt"])).stdout, "");
    }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);
