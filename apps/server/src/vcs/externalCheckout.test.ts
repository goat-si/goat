import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { git, initRepoWithCommit, layerTest, makeTmpDir } from "./testing/gitFixture.ts";

it.effect("follows a checkout made outside the driver after refs were cached", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["branch", "feature/outside"]);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* driver.listRefs({ cwd });

      yield* git(cwd, ["switch", "feature/outside"]);

      const refs = (yield* driver.listRefs({ cwd })).refs;
      const previous = refs.find((ref) => ref.name === initialBranch);
      assert.isTrue(refs.find((ref) => ref.name === "feature/outside")?.current);
      assert.isFalse(previous?.current);
      assert.isNull(previous?.worktreePath ?? null);
    }),
  ).pipe(Effect.provide(layerTest)),
);
