import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { VcsStatusStreamEvent } from "@goat/contracts";
import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";
import { baseLocalStatus, baseRemoteStatus, layerTestFor } from "./vcsStatusBroadcaster.testkit.ts";

it.effect("light subscribers omit totals and a later full subscriber receives them", () => {
  const branchChanges = { baseRef: "origin/main", insertions: 3, deletions: 1 };
  const state: Parameters<typeof layerTestFor>[0] = {
    currentLocalStatus: { ...baseLocalStatus, branchChanges },
    currentRemoteStatus: baseRemoteStatus,
    localStatusCalls: 0,
    remoteStatusCalls: 0,
    localInvalidationCalls: 0,
    remoteInvalidationCalls: 0,
    localStatusBranchChanges: [],
  };
  return Effect.gen(function* () {
    const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const events = yield* Queue.unbounded<VcsStatusStreamEvent>();
    yield* broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }).pipe(
      Stream.runForEach((event) => Queue.offer(events, event)),
      Effect.forkScoped,
    );
    const light = yield* Queue.take(events);
    assert.equal(light._tag, "snapshot");
    if (light._tag === "snapshot") assert.isUndefined(light.local.branchChanges);
    const full = yield* Stream.runHead(broadcaster.streamStatus({ cwd: "/repo" }));
    assert.equal(full._tag, "Some");
    if (full._tag === "Some" && full.value._tag === "snapshot")
      assert.deepStrictEqual(full.value.local.branchChanges, branchChanges);
    assert.deepStrictEqual(state.localStatusBranchChanges?.slice(0, 2), [false, true]);
  }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
});

it.effect("upgrades an in-flight light read when a full subscriber joins", () => {
  const branchChanges = { baseRef: "origin/main", insertions: 3, deletions: 1 };
  const state: Parameters<typeof layerTestFor>[0] = {
    currentLocalStatus: { ...baseLocalStatus, branchChanges },
    currentRemoteStatus: baseRemoteStatus,
    localStatusCalls: 0,
    remoteStatusCalls: 0,
    localInvalidationCalls: 0,
    remoteInvalidationCalls: 0,
    localStatusBranchChanges: [],
    fileSystem: FileSystem.makeNoop({ realPath: (cwd) => Effect.succeed(cwd) }),
  };
  return Effect.gen(function* () {
    const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    state.beforeLocalStatus = Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
    );
    const light = yield* broadcaster
      .streamStatus({ cwd: "/repo", includeRemote: false })
      .pipe(Stream.runHead, Effect.forkScoped({ startImmediately: true }));
    yield* Deferred.await(started);
    const full = yield* broadcaster
      .getStatus({ cwd: "/repo" })
      .pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Deferred.succeed(release, undefined);
    const result = yield* Fiber.join(full);
    yield* Fiber.join(light);
    assert.deepStrictEqual(result.branchChanges, branchChanges);
    assert.deepStrictEqual(state.localStatusBranchChanges?.slice(0, 2), [false, true]);
  }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
});

it.effect("reuses the full status after upgrading a light cache", () => {
  const state: Parameters<typeof layerTestFor>[0] = {
    currentLocalStatus: {
      ...baseLocalStatus,
      branchChanges: { baseRef: "origin/main", insertions: 3, deletions: 1 },
    },
    currentRemoteStatus: baseRemoteStatus,
    localStatusCalls: 0,
    remoteStatusCalls: 0,
    localInvalidationCalls: 0,
    remoteInvalidationCalls: 0,
  };
  return Effect.gen(function* () {
    const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    yield* broadcaster.refreshLocalStatus("/repo");
    yield* broadcaster.getStatus({ cwd: "/repo" });
    assert.equal(state.localStatusCalls, 2);
    yield* broadcaster.getStatus({ cwd: "/repo" });
    assert.equal(state.localStatusCalls, 2);
  }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
});
