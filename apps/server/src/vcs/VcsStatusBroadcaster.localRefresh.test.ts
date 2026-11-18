import { assert, it, describe } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import type { VcsStatusRemoteResult } from "@goat/contracts";
import { GitManagerError } from "@goat/contracts";

import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";
import {
  baseLocalStatus,
  baseRemoteStatus,
  layerTestFor,
  remoteStatusWithPr,
} from "./vcsStatusBroadcaster.testkit.ts";

describe("VcsStatusBroadcaster local-only refresh", () => {
  it.effect("a local-only refresh that overlaps the first remote poll keeps its PR", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const pollStarted = yield* Deferred.make<void>();
      const releasePoll = yield* Deferred.make<void>();
      state.beforeRemoteStatus = Deferred.succeed(pollStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releasePoll)),
      );
      const localSeen = yield* Deferred.make<void>();
      yield* broadcaster.streamStatus({ cwd: "/repo" }).pipe(
        Stream.runForEach((event) =>
          event._tag === "localUpdated" ? Deferred.succeed(localSeen, undefined) : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(pollStarted);
      state.beforeRemoteStatus = Effect.void;

      state.currentLocalStatus = { ...baseLocalStatus, hasWorkingTreeChanges: true };
      const refresh = yield* broadcaster
        .refreshStatus("/repo", { localOnly: true })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(localSeen);
      yield* Deferred.succeed(releasePoll, undefined);
      yield* Fiber.join(refresh);

      const status = yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.deepStrictEqual(status.pr, remoteStatusWithPr.pr);
      assert.equal(state.remoteStatusCalls, 1);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect(
    "a local-only refresh before any remote read leaves the PR refresh able to read",
    () => {
      const state: Parameters<typeof layerTestFor>[0] = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: remoteStatusWithPr,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };

      return Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        yield* broadcaster.refreshStatus("/repo", { localOnly: true });

        const remote = yield* broadcaster.refreshPullRequestStatus("/repo");
        assert.deepStrictEqual(remote?.pr, remoteStatusWithPr.pr);
        assert.equal(state.remoteStatusCalls, 1);
      }).pipe(Effect.provide(layerTestFor(state)));
    },
  );

  it.effect("a local-only refresh after a branch switch leaves the PR refresh able to read", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });

      state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/next" };
      const nextBranchRemote: VcsStatusRemoteResult = {
        ...baseRemoteStatus,
        pr: { ...remoteStatusWithPr.pr!, number: 3001, headRef: "feature/next" },
      };
      state.currentRemoteStatus = nextBranchRemote;
      yield* broadcaster.refreshStatus("/repo", { localOnly: true });

      const remote = yield* broadcaster.refreshPullRequestStatus("/repo");
      assert.deepStrictEqual(remote?.pr, nextBranchRemote.pr);
      assert.equal(state.remoteStatusCalls, 2);
    }).pipe(Effect.provide(layerTestFor(state)));
  });
});

describe("VcsStatusBroadcaster full refresh", () => {
  it.effect.each(["succeeds", "fails"] as const)(
    "overlapping callers share a fresh follow-up when the running refresh %s",
    (outcome) => {
      const state: Parameters<typeof layerTestFor>[0] = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: baseRemoteStatus,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
        fileSystem: FileSystem.makeNoop({ realPath: (cwd) => Effect.succeed(cwd) }),
      };
      const remoteError = new GitManagerError({
        operation: "VcsStatusBroadcaster.test",
        cwd: "/repo",
        detail: "remote status failed",
      });

      return Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        state.beforeRemoteStatus = Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(outcome === "fails" ? Effect.fail(remoteError) : Effect.void),
        );
        const refresh = broadcaster.refreshStatus("/repo");
        const first = yield* refresh.pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(started);
        state.beforeRemoteStatus = Effect.sync(() => {
          state.currentRemoteStatus = remoteStatusWithPr;
        });
        const forkRefresh = refresh.pipe(Effect.forkScoped({ startImmediately: true }));
        const cancelled = yield* forkRefresh;
        const second = yield* forkRefresh;
        const third = yield* forkRefresh;
        yield* Fiber.interrupt(cancelled);
        yield* broadcaster.refreshStatus("/repo", { localOnly: true });
        yield* Deferred.succeed(release, undefined);

        const initial = yield* Fiber.join(first);
        if (outcome === "fails") {
          assert.strictEqual(initial._tag === "Failure" && initial.failure, remoteError);
        } else {
          assert.isNull(initial._tag === "Success" && initial.success.pr);
        }
        assert.deepEqual((yield* Fiber.join(second)).pr, remoteStatusWithPr.pr);
        assert.deepEqual((yield* Fiber.join(third)).pr, remoteStatusWithPr.pr);
        const completedReads = outcome === "fails" ? 1 : 2;
        assert.equal(state.remoteStatusCalls, completedReads);

        yield* refresh;
        assert.equal(state.remoteStatusCalls, completedReads + 1);
      }).pipe(Effect.provide(layerTestFor(state)));
    },
  );
});
