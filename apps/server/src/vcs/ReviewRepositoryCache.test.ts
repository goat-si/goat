import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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

it.effect("reuses review layout, rereads branch, and handles removed and bare repositories", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const bare = yield* makeTmpDir("git-review-bare-");
      const spawned: Array<ReadonlyArray<string>> = [];
      const spawner = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command)) spawned.push(command.args.map(String));
        return delegate.spawn(
          ChildProcess.isStandardCommand(command) && command.options.cwd === bare
            ? ChildProcess.setEnv(command, { GIT_DIR: bare })
            : command,
        );
      });
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(layerServerConfig),
      );
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      yield* writeTextFile(cwd, "new.txt", "new\n");
      yield* driver.getReviewDiffPreview({ cwd });
      spawned.length = 0;
      yield* git(cwd, ["checkout", "-b", "outside-checkout"]);
      spawned.length = 0;
      const preview = yield* driver.getReviewDiffPreview({ cwd });
      assert.equal(
        preview.sources.find((source) => source.kind === "branch-range")?.headRef,
        "outside-checkout",
      );
      assert.equal(spawned.filter((args) => args.includes("--git-common-dir")).length, 0);
      assert.equal(spawned.filter((args) => args.includes("--show-toplevel")).length, 0);
      assert.equal(
        spawned.filter((args) => args.includes("symbolic-ref") && args.includes("HEAD")).length,
        1,
      );
      yield* (yield* FileSystem.FileSystem).remove(cwd, { recursive: true });
      assert.isEmpty((yield* driver.getReviewDiffPreview({ cwd })).sources);
      yield* git(bare, ["init", "--bare"]);
      assert.isEmpty((yield* driver.getReviewDiffPreview({ cwd: bare })).sources);
    }),
  ).pipe(Effect.provide(layerTest)),
);
