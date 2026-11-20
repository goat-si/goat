import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { VcsRefSnapshot, layer } from "./VcsRefSnapshot.ts";
import { git, initRepoWithCommit, layerTest, makeTmpDir } from "./testing/gitFixture.ts";

it.effect("detects ref, symbolic HEAD and shallow boundary changes", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    yield* initRepoWithCommit(cwd);
    const snapshot = yield* VcsRefSnapshot;
    const before = yield* snapshot(cwd);
    assert.isNotNull(before);
    yield* git(cwd, ["branch", "other"]);
    const refs = yield* snapshot(cwd);
    assert.notStrictEqual(refs, before);
    yield* git(cwd, ["symbolic-ref", "HEAD", "refs/heads/other"]);
    const head = yield* snapshot(cwd);
    assert.notStrictEqual(head, refs);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const commit = yield* git(cwd, ["rev-parse", "HEAD"]);
    yield* fs.writeFileString(path.join(cwd, ".git", "shallow"), `${commit}\n`);
    assert.notStrictEqual(yield* snapshot(cwd), head);
  }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(layerTest)))),
);

it.effect("falls back to a local reread when ref output is truncated", () =>
  Effect.gen(function* () {
    const snapshot = yield* VcsRefSnapshot;
    assert.isNull(yield* snapshot("/repo"));
  }).pipe(
    Effect.provide(
      layer.pipe(
        Layer.provideMerge(
          Layer.merge(
            Layer.mock(GitVcsDriver.GitVcsDriver)({
              execute: () =>
                Effect.succeed({
                  exitCode: ChildProcessSpawner.ExitCode(0),
                  stdout: "partial",
                  stderr: "",
                  stdoutTruncated: true,
                  stderrTruncated: false,
                }),
            }),
            NodeServices.layer,
          ),
        ),
      ),
    ),
  ),
);
