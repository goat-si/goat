import { assert, it, describe } from "@effect/vitest";
import type { VcsStatusLocalResult, VcsStatusRemoteResult } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";
import {
  baseLocalStatus,
  baseRemoteStatus,
  layerTestFor,
  remoteStatusWithPr,
} from "./vcsStatusBroadcaster.testkit.ts";

describe("checkout refresh", () => {
  it.effect("publishes a checkout's branch before returning, ahead of the remote read", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      const subscribed = yield* Deferred.make<void>();
      const localPublished = yield* Deferred.make<VcsStatusLocalResult>();
      const remotePublished = yield* Deferred.make<VcsStatusRemoteResult | null>();
      yield* broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }).pipe(
        Stream.runForEach((event) => {
          if (event._tag === "snapshot") return Deferred.succeed(subscribed, undefined);
          if (event._tag === "localUpdated") return Deferred.succeed(localPublished, event.local);
          return event.remote === null
            ? Effect.void
            : Deferred.succeed(remotePublished, event.remote);
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(subscribed);

      const releaseRemote = yield* Deferred.make<void>();
      state.beforeRemoteStatus = Deferred.await(releaseRemote);
      state.currentLocalStatus = { ...baseLocalStatus, refName: "main" };
      state.currentRemoteStatus = remoteStatusWithPr;
      yield* broadcaster.refreshAfterCheckout("/repo");

      assert.equal((yield* Deferred.await(localPublished)).refName, "main");
      assert.isFalse(yield* Deferred.isDone(remotePublished));

      yield* Deferred.succeed(releaseRemote, undefined);
      assert.deepStrictEqual(yield* Deferred.await(remotePublished), remoteStatusWithPr);
      assert.equal((yield* broadcaster.getStatus({ cwd: "/repo" })).pr?.number, 2978);
    }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
  });

  it.effect("bounds and coalesces checkout remote work and drains it after release", () => {
    const localFibers = new Set<number>();
    const completions = new Map<string, number>();
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      fileSystem: FileSystem.makeNoop({ realPath: (cwd) => Effect.succeed(cwd) }),
    };
    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const release = yield* Deferred.make<void>();
      const allComplete = yield* Deferred.make<void>();
      state.beforeLocalStatus = Effect.withFiber((fiber) =>
        Effect.sync(() => {
          localFibers.add(fiber.id);
        }),
      );
      state.beforeRemoteStatus = Deferred.await(release);
      state.onRemoteStatusComplete = (cwd) =>
        Effect.sync(() => {
          completions.set(cwd, (completions.get(cwd) ?? 0) + 1);
        }).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              [...completions.values()].reduce((sum, count) => sum + count, 0) === 32
                ? Deferred.succeed(allComplete, undefined)
                : Effect.void,
            ),
          ),
        );
      const paths = Array.from({ length: 16 }, (_, i) => `/repo-${i}`);
      for (const cwd of paths) yield* broadcaster.refreshAfterCheckout(cwd);
      for (const cwd of paths) {
        for (let i = 0; i < 8; i++) yield* broadcaster.refreshAfterCheckout(cwd);
      }
      assert.isAtMost(localFibers.size, 17); // caller plus at most 16 admitted workers
      const overflow = yield* broadcaster.refreshAfterCheckout("/overflow").pipe(Effect.result);
      assert.isTrue(Result.isFailure(overflow));
      assert.equal(state.remoteStatusCalls, 0);
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(allComplete);
      assert.equal(completions.size, 16);
      for (const count of completions.values()) assert.equal(count, 2);
      yield* broadcaster.refreshStatus("/after-drain");
    }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
  });

  it.effect("fails the checkout refresh when local publication fails", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      failLocalStatus: true,
    };
    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const result = yield* broadcaster.refreshAfterCheckout("/repo").pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      assert.equal(state.remoteStatusCalls, 0);
    }).pipe(Effect.provide(layerTestFor(state)));
  });
});
