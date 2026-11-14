import { assert, it, describe } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";
import { layerTestFor, baseLocalStatus, baseRemoteStatus } from "./vcsStatusBroadcaster.testkit.ts";

describe("merge divergence refresh", () => {
  it.effect.each([0, 2])(
    "refreshes merge divergence while a lookup ends with %s commits behind",
    (behindAfterLookup) => {
      const state: Parameters<typeof layerTestFor>[0] = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: { ...baseRemoteStatus, aheadCount: 2, behindCount: 3 },
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
        backgroundWorkEnabled: false,
      };
      return Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        yield* broadcaster.getStatus({ cwd: "/repo" });
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        state.beforeRemoteStatus = Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        const lookup = yield* broadcaster.refreshPullRequestStatus("/repo").pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        state.currentRemoteStatus = { ...baseRemoteStatus, aheadCount: 4, behindCount: 0 };
        yield* broadcaster.refreshLocalStatus("/repo");
        const status = yield* broadcaster.getStatus({ cwd: "/repo" });
        assert.equal(status.aheadCount, 4);
        assert.equal(status.behindCount, 0);
        assert.equal(state.remoteStatusCalls, 1);
        state.currentDivergence = { aheadCount: 4, behindCount: behindAfterLookup };
        state.currentRemoteStatus =
          behindAfterLookup > 0
            ? { ...baseRemoteStatus, ...state.currentDivergence }
            : { ...baseRemoteStatus, aheadCount: 2, behindCount: 3 };
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(lookup);
        const afterLookup = yield* broadcaster.getStatus({ cwd: "/repo" });
        assert.equal(afterLookup.aheadCount, 4);
        assert.equal(afterLookup.behindCount, behindAfterLookup);
      }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
    },
  );
});
