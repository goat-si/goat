import * as NodeServices from "@goat/shared/testing/nodeServicesWithCrypto";
import { assert, it } from "@effect/vitest";
import { CheckpointRef, VcsProcessExitError } from "@goat/contracts";
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

it.effect("checkpoint authorship works with git that rejects --diff-merges=remerge", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const liveProcess = yield* VcsProcess.VcsProcess;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "goat-checkpoint-old-git-" });
    const { git } = yield* makeCheckpointFixture(driver, cwd);
    yield* git(["commit", "-am", "baseline"]);
    const fromCheckpointRef = CheckpointRef.make("refs/t3/checkpoints/old-git/from");
    const toCheckpointRef = CheckpointRef.make("refs/t3/checkpoints/old-git/to");
    yield* driver.checkpoints.captureCheckpoint({ cwd, checkpointRef: fromCheckpointRef });
    yield* fs.writeFileString(path.join(cwd, "local.txt"), "local\n");
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "local"]);
    yield* driver.checkpoints.captureCheckpoint({
      cwd,
      checkpointRef: toCheckpointRef,
      previousCheckpointRef: fromCheckpointRef,
    });

    // Git before 2.36 (Ubuntu 22.04 ships 2.34.1) has no remerge diff mode.
    const oldGitDriver = yield* GitVcsDriver.makeVcsDriverShape().pipe(
      Effect.provideService(VcsProcess.VcsProcess, {
        run: (input) => {
          if (input.args.at(-1) === "version" && input.args.length <= 3) {
            return liveProcess
              .run(input)
              .pipe(Effect.map((result) => ({ ...result, stdout: "git version 2.34.1\n" })));
          }
          if (!input.args.includes("--diff-merges=remerge")) return liveProcess.run(input);
          return Effect.fail(
            new VcsProcessExitError({
              operation: input.operation,
              command: input.command,
              cwd: input.cwd,
              exitCode: 128,
              detail: "fatal: unknown value for --diff-merges: remerge",
            }),
          );
        },
      }),
    );
    assert.deepEqual(
      yield* oldGitDriver.checkpoints.listAuthoredPaths({
        cwd,
        fromCheckpointRef,
        toCheckpointRef,
      }),
      new Set(["local.txt"]),
    );
  }).pipe(Effect.scoped, Effect.provide(layerGitContract)),
);
