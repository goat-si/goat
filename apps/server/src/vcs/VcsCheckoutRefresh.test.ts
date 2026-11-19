import { assert, it, describe } from "@effect/vitest";
import type { VcsStatusLocalResult, VcsStatusRemoteResult } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
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
});
