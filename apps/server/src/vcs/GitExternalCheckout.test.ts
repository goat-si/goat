import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { layerTest, makeTmpDir, git, initRepoWithCommit } from "./testing/gitFixture.ts";

it.effect("includes a branch created by an external checkout after refs were cached", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    const { initialBranch } = yield* initRepoWithCommit(cwd);
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.listRefs({ cwd });
    yield* git(cwd, ["switch", "-c", "feature/outside"]);
    const refs = (yield* driver.listRefs({ cwd })).refs;
    assert.isTrue(refs.find((ref) => ref.name === "feature/outside")?.current);
    assert.isFalse(refs.find((ref) => ref.name === initialBranch)?.current);
  }).pipe(Effect.provide(layerTest)),
);
