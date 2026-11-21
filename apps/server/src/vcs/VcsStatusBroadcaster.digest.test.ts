import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Broadcaster from "./VcsStatusBroadcaster.ts";
import { baseLocalStatus, baseRemoteStatus, layerTestFor } from "./vcsStatusBroadcaster.testkit.ts";

it.effect(
  "refresh reports a stable digest until the refs change and omits it when unreadable",
  () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      refSnapshot: "refs-a" as string | null,
    };
    return Effect.gen(function* () {
      const broadcaster = yield* Broadcaster.VcsStatusBroadcaster;
      const first = yield* broadcaster.refreshStatus("/repo");
      assert.isString(first.refsDigest);
      assert.equal(
        (yield* broadcaster.refreshStatus("/repo", { localOnly: true })).refsDigest,
        first.refsDigest,
      );
      assert.equal((yield* broadcaster.refreshStatus("/repo")).refsDigest, first.refsDigest);
      state.refSnapshot = "refs-b";
      assert.notEqual((yield* broadcaster.refreshStatus("/repo")).refsDigest, first.refsDigest);
      state.refSnapshot = null;
      assert.isUndefined((yield* broadcaster.refreshStatus("/repo")).refsDigest);
    }).pipe(Effect.provide(layerTestFor(state)));
  },
);
