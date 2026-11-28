import { assert, it, describe } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";
import {
  baseLocalStatus,
  baseRemoteStatus,
  layerTestFor,
  remoteStatusWithPr,
} from "./vcsStatusBroadcaster.testkit.ts";

describe("VcsStatusBroadcaster cache", () => {
  it.effect.each(["passive subscriptions", "status reads", "local refreshes", "full refreshes"])(
    "bounds historical snapshots from %s while retaining recently read entries",
    (source) => {
      const state = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: baseRemoteStatus,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };

      return Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        yield* broadcaster.getStatus({ cwd: "/hot-repo" });
        for (let index = 0; index < 1_000; index += 1) {
          const cwd = `/visited-repo-${index}`;
          if (source === "passive subscriptions") {
            yield* Stream.runHead(broadcaster.streamStatus({ cwd, includeRemote: false }));
          } else if (source === "status reads") {
            yield* broadcaster.getStatus({ cwd });
          } else if (source === "local refreshes") {
            yield* broadcaster.refreshLocalStatus(cwd);
          } else {
            yield* broadcaster.refreshStatus(cwd);
          }
          const localCalls = state.localStatusCalls;
          const remoteCalls = state.remoteStatusCalls;
          yield* broadcaster.getStatus({ cwd: "/hot-repo" });
          assert.equal(state.localStatusCalls, localCalls);
          assert.equal(state.remoteStatusCalls, remoteCalls);
        }

        const localCalls = state.localStatusCalls;
        yield* Stream.runHead(
          broadcaster.streamStatus({ cwd: "/visited-repo-999", includeRemote: false }),
        );
        assert.equal(state.localStatusCalls, localCalls);
        yield* Stream.runHead(
          broadcaster.streamStatus({ cwd: "/visited-repo-0", includeRemote: false }),
        );
        assert.equal(state.localStatusCalls, localCalls + 1);
      }).pipe(Effect.provide(layerTestFor(state)));
    },
  );

  it.effect("keeps a watched cwd's snapshot until its last subscriber leaves", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      backgroundWorkEnabled: false,
      automaticFetchInterval: Effect.succeed(Duration.zero),
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const subscription = yield* Scope.make();
      const remoteLoaded = yield* Deferred.make<void>();
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/active-repo" }), (event) =>
        event._tag === "remoteUpdated" ? Deferred.succeed(remoteLoaded, undefined) : Effect.void,
      ).pipe(Effect.forkIn(subscription));
      yield* Deferred.await(remoteLoaded);
      for (let index = 0; index < 1_000; index += 1) {
        yield* broadcaster.getStatus({ cwd: `/visited-repo-${index}` });
      }

      // With fetching disabled, nothing would reload a remote dropped from the cache.
      const localCalls = state.localStatusCalls;
      const remoteCalls = state.remoteStatusCalls;
      const snapshot = yield* Stream.runHead(broadcaster.streamStatus({ cwd: "/active-repo" }));
      assert.deepStrictEqual(Option.getOrThrow(snapshot), {
        _tag: "snapshot",
        local: baseLocalStatus,
        remote: remoteStatusWithPr,
      });
      assert.equal(state.localStatusCalls, localCalls);
      assert.equal(state.remoteStatusCalls, remoteCalls);
      // Turn completion skips a cwd it has no snapshot for.
      const turnEndRemote = { ...remoteStatusWithPr, aheadCount: 1 };
      state.currentRemoteStatus = turnEndRemote;
      assert.deepStrictEqual(
        yield* broadcaster.refreshPullRequestStatus("/active-repo"),
        turnEndRemote,
      );

      yield* Scope.close(subscription, Exit.void);
      for (let index = 1_000; index < 2_000; index += 1) {
        yield* broadcaster.getStatus({ cwd: `/visited-repo-${index}` });
      }
      const releasedCalls = state.localStatusCalls;
      yield* broadcaster.getStatus({ cwd: "/active-repo" });
      assert.equal(state.localStatusCalls, releasedCalls + 1);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect("keeps an unwatched refresh coherent while other directories fill the cache", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: { ...remoteStatusWithPr, aheadCount: 2 },
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    const policyStarted = Deferred.makeUnsafe<void>();
    const releasePolicy = Deferred.makeUnsafe<void>();
    const layer = layerTestFor(state).pipe(
      Layer.provide(
        Layer.succeed(VcsStatusBroadcaster.VcsAutoPullPolicy, {
          isEnabled: () =>
            Deferred.succeed(policyStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releasePolicy)),
              Effect.as(false),
            ),
        }),
      ),
    );
    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const refresh = yield* broadcaster.refreshStatus("/refreshing-repo").pipe(Effect.forkScoped);
      yield* Deferred.await(policyStarted);
      for (let index = 0; index < 256; index += 1) {
        yield* broadcaster.refreshLocalStatus(`/other-repo-${index}`);
      }
      yield* Deferred.succeed(releasePolicy, undefined);
      const result = yield* Fiber.join(refresh);
      assert.deepStrictEqual(result, { ...baseLocalStatus, ...state.currentRemoteStatus });
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("trims excess snapshots when the last watched directories are released", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      backgroundWorkEnabled: false,
    };
    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const scopes = [];
      for (let index = 0; index < 257; index += 1) {
        const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
          Scope.close(scope, Exit.void),
        );
        scopes.push(scope);
        const ready = yield* Deferred.make<void>();
        yield* Stream.runForEach(
          broadcaster.streamStatus({ cwd: `/watched-repo-${index}`, includeRemote: false }),
          () => Deferred.succeed(ready, undefined),
        ).pipe(Effect.forkIn(scope));
        yield* Deferred.await(ready);
      }
      for (const scope of scopes) yield* Scope.close(scope, Exit.void);
      const reads = state.localStatusCalls;
      // A cache read protects its own cwd before trimming; only teardown can evict this oldest cwd.
      yield* Stream.runHead(
        broadcaster.streamStatus({ cwd: "/watched-repo-0", includeRemote: false }),
      );
      assert.equal(state.localStatusCalls, reads + 1);
    }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
  });
});
