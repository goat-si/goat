import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  git,
  initRepoWithCommit,
  layerTest,
  makeTmpDir,
  writeTextFile,
} from "./testing/gitFixture.ts";

it.layer(layerTest)("remote switch collisions", (it) => {
  it.effect.each(["untracked", "other-remote"] as const)(
    "refuses a remote switch that collides with a local branch (%s)",
    (tracking) =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const remote = yield* makeTmpDir("git-remote-");
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "upstream", remote]);
        yield* git(cwd, ["push", "upstream", "HEAD:refs/heads/feature"]);
        yield* git(cwd, ["fetch", "upstream"]);
        yield* git(cwd, ["checkout", "--no-track", "-b", "feature"]);
        yield* git(cwd, ["commit", "--allow-empty", "-m", "Local work"]);
        if (tracking === "other-remote") {
          yield* git(cwd, ["remote", "add", "origin", remote]);
          yield* git(cwd, ["fetch", "origin"]);
          yield* git(cwd, ["branch", "--set-upstream-to=origin/feature", "feature"]);
        }
        const featureHead = yield* git(cwd, ["rev-parse", "feature"]);
        const upstream = yield* git(cwd, [
          "for-each-ref",
          "--format=%(upstream)",
          "refs/heads/feature",
        ]);
        yield* git(cwd, ["checkout", initialBranch]);
        const head = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* writeTextFile(cwd, "README.md", "Uncommitted work\n");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const result = yield* driver
          .switchRef({ cwd, refName: "upstream/feature" })
          .pipe(Effect.result);
        assert.isTrue(Result.isFailure(result));
        assert.equal(yield* git(cwd, ["branch", "--show-current"]), initialBranch);
        assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), head);
        assert.equal(yield* git(cwd, ["rev-parse", "feature"]), featureHead);
        assert.equal(
          yield* git(cwd, ["for-each-ref", "--format=%(upstream)", "refs/heads/feature"]),
          upstream,
        );
        assert.equal(
          yield* (yield* FileSystem.FileSystem).readFileString(
            (yield* Path.Path).join(cwd, "README.md"),
          ),
          "Uncommitted work\n",
        );
        // Selecting the existing local branch remains an explicit, attached checkout.
        assert.equal((yield* driver.switchRef({ cwd, refName: "feature" })).refName, "feature");
        assert.equal(yield* git(cwd, ["symbolic-ref", "HEAD"]), "refs/heads/feature");
      }),
  );
});
