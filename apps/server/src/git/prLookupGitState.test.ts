import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { countingTracer } from "../observability/countingTracer.testkit.ts";
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

it.effect("a background lookup answered from memory records no span per remembered key", () =>
  Effect.gen(function* () {
    const state = yield* makePrLookupGitState({ normalizeCwd: Effect.succeed, capacity: 16 });
    let reads = 0;
    const read = Effect.sync(() => {
      reads++;
      return "origin";
    });
    const spans = new Map<string, number>();
    // The one-minute sweep asks for the same keys while nothing in the repository changed.
    yield* Effect.gen(function* () {
      for (let minute = 0; minute < 4; minute++) {
        for (const key of ["remotes", "config\u0000branch.main.remote"])
          assert.equal(yield* state.remember("/repo", key, false, read), "origin");
        yield* TestClock.adjust("1 minute");
      }
    }).pipe(Effect.withTracer(countingTracer(spans)));
    assert.equal(reads, 2);
    assert.equal(spans.get("GitManager.rememberPrLookupGitState") ?? 0, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a refresh does not reuse a git read that started before it", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    yield* initRepoWithCommit(cwd);
    const state = yield* makePrLookupGitState({ normalizeCwd: Effect.succeed, capacity: 16 });
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let reads = 0;
    const read = Effect.gen(function* () {
      reads++;
      if (reads > 1) return "after refresh";
      yield* Deferred.succeed(started, undefined);
      yield* Deferred.await(release);
      return "before refresh";
    });
    yield* state.validate(cwd, "main", false);
    const before = yield* Effect.forkChild(state.remember(cwd, "remotes", false, read));
    yield* Deferred.await(started);
    yield* state.validate(cwd, "main", true);
    const after = yield* Effect.forkChild(state.remember(cwd, "remotes", false, read), {
      startImmediately: true,
    });
    yield* Deferred.succeed(release, undefined);
    assert.equal(yield* Fiber.join(before), "before refresh");
    assert.equal(yield* Fiber.join(after), "after refresh");
    assert.equal(yield* state.remember(cwd, "remotes", false, read), "after refresh");
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect(
  "a background lookup keeps its remembered git reads when another branch's config section changes",
  () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["remote", "add", "origin", "https://github.com/example/project.git"]);
      yield* git(cwd, ["checkout", "-b", "feature/own"]);
      yield* git(cwd, ["config", "branch.feature/own.remote", "origin"]);
      const state = yield* makePrLookupGitState({ normalizeCwd: Effect.succeed, capacity: 16 });
      let reads = 0;
      const read = Effect.sync(() => {
        reads++;
        return "origin";
      });
      const sweep = Effect.gen(function* () {
        yield* state.validate(cwd, "feature/own", false);
        for (const key of ["remotes", "config\u0000branch.feature/own.remote"])
          yield* state.remember(cwd, key, false, read);
      });
      yield* sweep;
      // Another worktree's agent rewrites the shared config while publishing its own branch.
      yield* git(cwd, ["config", "branch.feature/other.remote", "origin"]);
      yield* git(cwd, ["config", "branch.feature/other.merge", "refs/heads/feature/other"]);
      yield* TestClock.adjust("1 minute");
      yield* sweep;
      assert.equal(reads, 2);
      // Its own upstream and the remotes still invalidate.
      yield* git(cwd, ["config", "branch.feature/own.merge", "refs/heads/feature/own"]);
      yield* sweep;
      assert.equal(reads, 4);
      yield* git(cwd, ["remote", "set-url", "origin", "https://github.com/example/moved.git"]);
      yield* sweep;
      assert.equal(reads, 6);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("forgetting refreshed repositories beyond capacity never lets an older read answer", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    yield* initRepoWithCommit(cwd);
    const state = yield* makePrLookupGitState({ normalizeCwd: Effect.succeed, capacity: 2 });
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let reads = 0;
    const read = Effect.gen(function* () {
      reads++;
      if (reads > 1) return "after refresh";
      yield* Deferred.succeed(started, undefined);
      yield* Deferred.await(release);
      return "before refresh";
    });
    yield* state.validate(cwd, "main", false);
    const before = yield* Effect.forkChild(state.remember(cwd, "remotes", false, read));
    yield* Deferred.await(started);
    yield* state.validate(cwd, "main", true);
    // Refreshes of other repositories push this one out of the bounded generation table.
    for (const other of ["/other-a", "/other-b", "/other-c"])
      yield* state.validate(other, "main", true);
    yield* Deferred.succeed(release, undefined);
    assert.equal(yield* Fiber.join(before), "before refresh");
    assert.equal(yield* state.remember(cwd, "remotes", false, read), "after refresh");
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
