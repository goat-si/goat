import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";
import { baseLocalStatus, baseRemoteStatus, layerTestFor } from "./vcsStatusBroadcaster.testkit.ts";
import { VcsRefSnapshot } from "./VcsRefSnapshot.ts";

it.effect("reuses the local status read when refs are unchanged", () => {
  const state = {
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
    yield* broadcaster.refreshStatus("/repo");
    assert.equal(state.localStatusCalls, 1);
  }).pipe(
    Effect.provide(layerTestFor(state)),
    Effect.provideService(VcsRefSnapshot, () => Effect.succeed("same")),
  );
});

it.effect.each([
  { name: "refs change", values: ["before", "after"] },
  { name: "the first snapshot is unavailable", values: [null] },
  { name: "the second snapshot is unavailable", values: ["before", null] },
])("rereads local status when $name", ({ values }) => {
  const state = {
    currentLocalStatus: baseLocalStatus,
    currentRemoteStatus: baseRemoteStatus,
    localStatusCalls: 0,
    remoteStatusCalls: 0,
    localInvalidationCalls: 0,
    remoteInvalidationCalls: 0,
    fileSystem: FileSystem.makeNoop({ realPath: (cwd) => Effect.succeed(cwd) }),
  };
  const snapshots = [...values];
  return Effect.gen(function* () {
    const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    yield* broadcaster.refreshStatus("/repo");
    assert.equal(state.localStatusCalls, 2);
  }).pipe(
    Effect.provide(layerTestFor(state)),
    Effect.provideService(VcsRefSnapshot, () => Effect.sync(() => snapshots.shift() ?? null)),
  );
});
