import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";
import {
  baseLocalStatus,
  baseRemoteStatus,
  remoteStatusWithPr,
  layerTestFor,
} from "./vcsStatusBroadcaster.testkit.ts";

it.effect("a remote poll that moves no ref does not re-read local status", () => {
  const state: Parameters<typeof layerTestFor>[0] = {
    refSnapshot: "initial",
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
    const remoteUpdates = yield* Queue.unbounded<void>();
    yield* broadcaster.streamStatus({ cwd: "/repo" }).pipe(
      Stream.runForEach((event) => {
        if (event._tag === "snapshot") return Deferred.succeed(subscribed, undefined);
        if (event._tag === "remoteUpdated") return Queue.offer(remoteUpdates, undefined);
        return Effect.void;
      }),
      Effect.forkScoped,
    );
    yield* Deferred.await(subscribed);
    state.currentRemoteStatus = remoteStatusWithPr;
    yield* TestClock.adjust("30 seconds");
    yield* Queue.take(remoteUpdates);
    const localCalls = state.localStatusCalls;
    const remoteCalls = state.remoteStatusCalls;

    state.currentRemoteStatus = baseRemoteStatus;
    yield* TestClock.adjust("30 seconds");
    yield* Queue.take(remoteUpdates);
    assert.equal(state.remoteStatusCalls, remoteCalls + 1);
    assert.equal(state.localStatusCalls, localCalls);

    state.refSnapshot = "fetched";
    state.currentRemoteStatus = remoteStatusWithPr;
    yield* TestClock.adjust("30 seconds");
    yield* Queue.take(remoteUpdates);
    assert.equal(state.localStatusCalls, localCalls + 1);
  }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
});
