import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { git, initRepoWithCommit, layerTest, makeTmpDir } from "./testing/gitFixture.ts";

it.effect("reads the project's own repository when the server inherited GIT_DIR", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const cwd = yield* makeTmpDir();
      const other = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* initRepoWithCommit(other);
      yield* git(other, ["switch", "-c", "other-repository"]);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
      vi.stubEnv("GIT_DIR", path.join(other, ".git"));
      assert.equal((yield* driver.statusDetailsLocal(cwd)).branch, initialBranch);
      const refs = yield* driver.listRefs({ cwd });
      assert.isFalse(refs.refs.some((ref) => ref.name === "other-repository"));
    }),
  ).pipe(Effect.provide(layerTest)),
);
