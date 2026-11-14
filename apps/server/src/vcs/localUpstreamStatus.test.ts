import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { git, initRepoWithCommit, layerTest, makeTmpDir } from "./testing/gitFixture.ts";

it.layer(layerTest)("local upstream status", (it) => {
  it.effect("reports a local upstream without a slash and its divergence", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const initialBranch = yield* git(cwd, ["symbolic-ref", "--short", "HEAD"]);
      yield* git(cwd, ["branch", "feature"]);
      yield* git(cwd, ["commit", "--allow-empty", "-m", "advance base"]);
      yield* git(cwd, ["checkout", "feature"]);
      yield* git(cwd, ["branch", `--set-upstream-to=${initialBranch}`]);
      const driver = yield* GitVcsDriver.GitVcsDriver;

      const remoteStatus = yield* driver.statusDetailsRemote(cwd, { refreshUpstream: false });
      assert.equal(remoteStatus.upstreamRef, initialBranch);
      assert.equal(remoteStatus.hasUpstream, true);
      assert.equal(remoteStatus.aheadCount, 0);
      assert.equal(remoteStatus.behindCount, 1);
    }),
  );
});
