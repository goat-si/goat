import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { layerTest, makeTmpDir, git } from "./testing/gitFixture.ts";

it.effect(
  "refreshes remote status after external init while refs still cache a non-repository",
  () =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.realPath(yield* makeTmpDir());
      assert.isFalse((yield* driver.listRefs({ cwd })).isRepo);
      yield* git(cwd, ["init"]);

      assert.isFalse((yield* driver.statusDetailsLocal(cwd)).hasOriginRemote);
      yield* driver.ensureRemote({ cwd, preferredName: "origin", url: cwd });
      assert.isTrue((yield* driver.statusDetailsLocal(cwd)).hasOriginRemote);
    }).pipe(Effect.provide(layerTest)),
);
