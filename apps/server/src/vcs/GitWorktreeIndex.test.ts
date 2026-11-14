import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  git,
  initRepoWithCommit,
  layerTest,
  makeTmpDir,
  writeTextFile,
} from "./testing/gitFixture.ts";

it.layer(layerTest)("worktree index refresh", (it) => {
  it.effect("refreshes a new worktree's index after the checkout second", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      for (let file = 0; file < 50; file++) {
        yield* writeTextFile(cwd, `src/file-${file}.txt`, `contents ${file}\n`);
      }
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "more files"]);
      const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "fresh");
      const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2020-01-01T00:00:00Z"));
      yield* driver.createWorktree(
        { cwd, path: worktreePath, refName: initialBranch, newRefName: "feature/fresh" },
        {
          progress: {
            onWorktreeClaimed: () =>
              Effect.gen(function* () {
                const indexOutput = yield* driver.execute({
                  operation: "test.worktreeIndex",
                  cwd: worktreePath,
                  args: ["rev-parse", "--git-path", "index"],
                });
                const index = path.resolve(worktreePath, indexOutput.stdout.trim());
                yield* fs.utimes(path.join(worktreePath, "README.md"), timestamp, timestamp);
                for (let file = 0; file < 50; file++) {
                  yield* fs.utimes(
                    path.join(worktreePath, `src/file-${file}.txt`),
                    timestamp,
                    timestamp,
                  );
                }
                yield* fs.utimes(index, timestamp, timestamp);
              }).pipe(Effect.orDie),
          },
        },
      );
      const indexPath = path.resolve(
        worktreePath,
        yield* git(worktreePath, ["rev-parse", "--git-path", "index"]),
      );
      const indexSecond = Math.floor(
        Option.getOrThrow((yield* fs.stat(indexPath)).mtime).getTime() / 1000,
      );
      const entrySeconds = Array.from(
        (yield* git(worktreePath, ["ls-files", "--debug"])).matchAll(/^ {2}mtime: (\d+):/gm),
        ([, seconds]) => Number(seconds),
      );
      assert.equal(entrySeconds.length, 51);
      assert.deepEqual(
        entrySeconds.filter((seconds) => seconds >= indexSecond),
        [],
      );
    }),
  );
  it.effect("returns the worktree when its index refresh fails", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* writeTextFile(
        cwd,
        ".git/hooks/post-checkout",
        '#!/bin/sh\ntouch "$(git rev-parse --git-path index).lock"\n',
      );
      yield* fs.chmod(path.join(cwd, ".git/hooks/post-checkout"), 0o755);
      const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "locked");
      const created = yield* driver.createWorktree({
        cwd,
        path: worktreePath,
        refName: initialBranch,
        newRefName: "feature/locked",
      });
      assert.equal(created.worktree.path, worktreePath);
      const indexPath = path.resolve(
        worktreePath,
        yield* git(worktreePath, ["rev-parse", "--git-path", "index"]),
      );
      assert.isTrue(yield* fs.exists(`${indexPath}.lock`));
    }),
  );
});
