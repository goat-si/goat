import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
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

it.effect("only skips the untracked listing when a hinted file is still tracked", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    yield* initRepoWithCommit(cwd);
    yield* writeTextFile(cwd, "README.md", "changed\n");
    const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
    let listings = 0;
    const spawner = ChildProcessSpawner.make((command) => {
      if (ChildProcess.isStandardCommand(command) && command.args.includes("--others")) listings++;
      return delegate.spawn(command);
    });
    const driver = yield* makeGitVcsDriverCore().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provide(layerServerConfig),
    );
    const read = (hint: boolean) =>
      driver.getReviewDiffPreview({
        cwd,
        file: {
          path: "README.md",
          previousPath: null,
          sourceKind: "working-tree",
          ...(hint ? { changeType: "change" } : {}),
        },
      });
    assert.include((yield* read(true)).sources[0]!.diff, "+changed");
    assert.equal(listings, 0);
    yield* git(cwd, ["rm", "--cached", "-q", "README.md"]);
    const stale = yield* read(true);
    assert.equal(listings, 1);
    assert.deepStrictEqual(stale.sources, (yield* read(false)).sources);
  }).pipe(Effect.provide(layerTest)),
);
