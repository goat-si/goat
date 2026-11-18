// @effect-diagnostics nodeBuiltinImport:off - check that Git did not create FETCH_HEAD.
import * as NodeFS from "node:fs";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  git,
  initRepoWithCommit,
  layerTest,
  makeTmpDir,
  writeTextFile,
} from "./testing/gitFixture.ts";

it.layer(layerTest)("background status fetch", (it) => {
  it.effect("leaves FETCH_HEAD for user pulls", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-vcs-driver-remote-");
      const updater = yield* makeTmpDir("git-vcs-driver-updater-");
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "-u", "origin", initialBranch]);
      yield* git(updater, ["clone", remote, "."]);
      yield* git(updater, ["config", "user.email", "test@test.com"]);
      yield* git(updater, ["config", "user.name", "Test"]);
      yield* writeTextFile(updater, "remote.txt", "remote\n");
      yield* git(updater, ["add", "remote.txt"]);
      yield* git(updater, ["commit", "-m", "remote commit"]);
      yield* git(updater, ["push", "origin", initialBranch]);
      const fetchHead = (yield* Path.Path).join(cwd, ".git", "FETCH_HEAD");
      assert.isFalse(NodeFS.existsSync(fetchHead));
      const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetailsRemote(cwd);
      assert.equal(status.behindCount, 1);
      assert.isFalse(NodeFS.existsSync(fetchHead));
    }),
  );
});
