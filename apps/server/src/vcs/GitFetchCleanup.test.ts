import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  layerTest,
  makeTmpDir,
  writeTextFile,
  git,
  initRepoWithCommit,
} from "./testing/gitFixture.ts";

it.layer(layerTest)("cleanup merge-check fetch", (it) => {
  it.effect("does not run automatic maintenance on the repository", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-cleanup-remote-");
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "-u", "origin", initialBranch]);
      yield* git(cwd, ["repack", "-d"]);
      yield* writeTextFile(cwd, "second.txt", "second\n");
      yield* git(cwd, ["add", "second.txt"]);
      yield* git(cwd, ["commit", "-m", "second commit"]);
      yield* git(cwd, ["push"]);
      yield* git(cwd, ["repack", "-d"]);
      yield* git(cwd, ["config", "gc.autoPackLimit", "1"]);
      yield* git(cwd, ["config", "gc.autoDetach", "false"]);
      yield* git(cwd, ["config", "maintenance.autoDetach", "false"]);
      yield* git(cwd, ["config", "maintenance.auto", "true"]);
      const packs = git(cwd, ["count-objects", "-v"]).pipe(
        Effect.map((out) => out.match(/^packs: (\d+)$/m)?.[1]),
      );
      assert.equal(yield* packs, "2");
      yield* (yield* GitVcsDriver.GitVcsDriver).fetchRemoteTrackingBranch({
        cwd,
        remoteName: "origin",
        remoteBranch: initialBranch,
      });
      assert.equal(yield* packs, "2");
    }),
  );
});
