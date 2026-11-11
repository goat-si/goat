import { assert, it, describe } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import type { VcsStatusRemoteResult } from "@goat/contracts";

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
