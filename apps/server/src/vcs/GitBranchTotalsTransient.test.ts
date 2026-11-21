import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import {
  git,
  initRepoWithCommit,
  layerServerConfig,
  layerTest,
  makeTmpDir,
  writeTextFile,
} from "./testing/gitFixture.ts";

it.effect("retries a transient branch-diff spawn failure on the next status read", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTmpDir("git-branch-transient-");
    yield* initRepoWithCommit(cwd);
    yield* git(cwd, ["branch", "-M", "main"]);
    yield* git(cwd, ["checkout", "-b", "feature"]);
    yield* writeTextFile(cwd, "feature.txt", "one\n");
    yield* git(cwd, ["add", "feature.txt"]);
    yield* git(cwd, ["commit", "-m", "feature"]);
    let attempts = 0;
    const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.suspend(() => {
        if (
          ChildProcess.isStandardCommand(command) &&
          command.args.includes("diff-index") &&
          !command.args.includes("HEAD")
        ) {
          attempts++;
          if (attempts === 1)
            return Effect.fail(
              new PlatformError.PlatformError(
                new PlatformError.SystemError({
                  _tag: "Unknown",
                  module: "ChildProcess",
                  method: "spawn",
                  pathOrDescriptor: "git",
                }),
              ),
            );
        }
        return delegate.spawn(command);
      }),
    );
    const driver = yield* makeGitVcsDriverCore().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provide(layerServerConfig),
    );
    const read = driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
    assert.isUndefined((yield* read).branchChanges);
    assert.deepStrictEqual((yield* read).branchChanges, {
      baseRef: "main",
      insertions: 1,
      deletions: 0,
    });
    assert.equal(attempts, 2);
  }).pipe(Effect.provide(layerTest)),
);
