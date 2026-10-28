import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { layerTest, makeTmpDir, git, initRepoWithCommit } from "../vcs/testing/gitFixture.ts";
import { makePrLookupGitState } from "./prLookupGitState.ts";

const merged = { url: "https://github.com/example/project/pull/7", state: "merged" } as const;

it.effect(
  "a verified merged pull request skips the fresh-git recheck until a remote-tracking ref moves",
  () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["checkout", "-b", "feature/merged"]);
      yield* git(cwd, ["commit", "--allow-empty", "-m", "feature"]);
      yield* git(cwd, ["update-ref", "refs/remotes/origin/feature/merged", "HEAD"]);
      const state = yield* makePrLookupGitState({
        normalizeCwd: Effect.succeed,
        capacity: 16,
      });
      let rechecks = 0;
      const recheck = Effect.sync(() => {
        rechecks++;
        return merged;
      });
      // Each background sweep validates the git metadata, then asks again.
      const sweep = Effect.gen(function* () {
        yield* state.validate(cwd, "feature/merged", false);
        return yield* state.verifyTerminal(cwd, "feature/merged", merged, recheck);
      });
      assert.deepEqual(yield* sweep, merged);
      for (let minute = 0; minute < 3; minute++) {
        yield* TestClock.adjust("1 minute");
        assert.deepEqual(yield* sweep, merged);
      }
      assert.equal(rechecks, 1);
      // A fetch moves only the remote-tracking ref.
      yield* git(cwd, ["update-ref", "refs/remotes/origin/feature/merged", "HEAD~1"]);
      yield* sweep;
      assert.equal(rechecks, 2);
      // The confirmation also expires with the background TTL.
      yield* TestClock.adjust("5 minutes");
      yield* sweep;
      assert.equal(rechecks, 3);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
