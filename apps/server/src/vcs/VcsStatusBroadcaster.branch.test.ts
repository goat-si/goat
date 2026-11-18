import { assert, it, describe } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";
import { baseLocalStatus, layerTestFor } from "./vcsStatusBroadcaster.testkit.ts";

describe("VcsStatusBroadcaster branch status", () => {
  it.effect(
    "streams fresh branch-only reads, detached HEAD, non-repositories, and detailed demand without mixing results",
    () => {
      const state: Parameters<typeof layerTestFor>[0] = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: null,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
        fileSystem: FileSystem.makeNoop({
          realPath: (cwd) => Effect.succeed(cwd === "/alias" ? "/repo" : cwd),
        }),
      };
      return Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const branches = yield* Stream.toPull(broadcaster.streamBranchStatus({ cwd: "/repo" }));
        assert.deepEqual(yield* branches, [{ refName: baseLocalStatus.refName }]);
        assert.equal(state.localStatusCalls, 0);
        state.currentLocalStatus = { ...baseLocalStatus, refName: "external" };
        yield* broadcaster.refreshBranchStatus({ cwd: "/repo" });
        assert.deepEqual(yield* branches, [{ refName: "external" }]);
        state.currentLocalStatus = { ...baseLocalStatus, refName: null };
        yield* broadcaster.refreshBranchStatus({ cwd: "/repo" });
        assert.deepEqual(yield* branches, [{ refName: null }]);
        assert.equal(state.localStatusCalls, 0);
        const detailScope = yield* Scope.make();
        const details = yield* Stream.toPull(
          broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
        ).pipe(Scope.provide(detailScope));
        assert.deepEqual(yield* details, [
          { _tag: "snapshot", local: state.currentLocalStatus, remote: null },
        ]);
        const callsWithDetail = state.localStatusCalls;
        const extraBranches = yield* Stream.toPull(
          broadcaster.streamBranchStatus({ cwd: "/repo" }),
        );
        yield* extraBranches;
        yield* broadcaster.refreshBranchStatus({ cwd: "/repo" });
        assert.equal(state.localStatusCalls, callsWithDetail);
        state.currentLocalStatus = {
          ...baseLocalStatus,
          refName: "changed",
          workingTree: { files: [], insertions: 12, deletions: 3 },
        };
        yield* broadcaster.refreshBranchStatus({ cwd: "/repo" });
        assert.deepEqual(yield* details, [
          { _tag: "localUpdated", local: state.currentLocalStatus },
        ]);
        assert.deepEqual(yield* branches, [{ refName: "changed" }]);
        const secondScope = yield* Scope.make();
        const secondDetails = yield* Stream.toPull(
          broadcaster.streamStatus({ cwd: "/alias", includeRemote: false }),
        ).pipe(Scope.provide(secondScope));
        yield* secondDetails;
        yield* Scope.close(detailScope, Exit.void);
        state.currentLocalStatus = {
          ...state.currentLocalStatus,
          workingTree: { files: [], insertions: 20, deletions: 4 },
        };
        yield* broadcaster.refreshLocalStatus("/repo");
        assert.deepEqual(yield* secondDetails, [
          { _tag: "localUpdated", local: state.currentLocalStatus },
        ]);
        yield* Scope.close(secondScope, Exit.void);
        const callsAfterRelease = state.localStatusCalls;
        state.currentLocalStatus = {
          ...state.currentLocalStatus,
          workingTree: { files: [], insertions: 30, deletions: 5 },
        };
        yield* broadcaster.refreshBranchStatus({ cwd: "/repo" });
        assert.equal(state.localStatusCalls, callsAfterRelease);
        const reopened = yield* Stream.toPull(
          broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
        );
        assert.deepEqual(yield* reopened, [
          { _tag: "snapshot", local: state.currentLocalStatus, remote: null },
        ]);
        state.currentLocalStatus = {
          ...baseLocalStatus,
          isRepo: false,
          refName: null,
        };
        yield* broadcaster.refreshBranchStatus({ cwd: "/repo" });
        assert.deepEqual(yield* reopened, [
          { _tag: "localUpdated", local: state.currentLocalStatus },
        ]);
        assert.deepEqual(yield* branches, [{ refName: null }]);
        assert.equal(state.remoteStatusCalls, 0);
      }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
    },
  );

  it.effect("upgrades an in-flight branch refresh when detailed demand arrives", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: null,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const reading = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      state.branchRead = () =>
        Deferred.succeed(reading, undefined).pipe(
          Effect.andThen(Deferred.await(resume)),
          Effect.as(baseLocalStatus.refName),
        );
      const refresh = yield* broadcaster
        .refreshBranchStatus({ cwd: "/repo" })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(reading);
      const detailsFiber = yield* Stream.runHead(
        broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
      ).pipe(Effect.forkScoped);
      state.currentLocalStatus = {
        ...baseLocalStatus,
        workingTree: { files: [], insertions: 8, deletions: 2 },
      };
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(refresh);
      assert.deepEqual(
        yield* Fiber.join(detailsFiber),
        Option.some({ _tag: "snapshot" as const, local: state.currentLocalStatus, remote: null }),
      );
    }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
  });
});

const newState = (): Parameters<typeof layerTestFor>[0] => ({
  fileSystem: FileSystem.makeNoop({ realPath: (cwd) => Effect.succeed(cwd) }),
  currentLocalStatus: baseLocalStatus,
  currentRemoteStatus: null,
  localStatusCalls: 0,
  remoteStatusCalls: 0,
  localInvalidationCalls: 0,
  remoteInvalidationCalls: 0,
});
it.effect("detail join during invalidation must get fresh totals", () => {
  const state = newState();
  return Effect.gen(function* () {
    const b = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const oldScope = yield* Scope.make();
    const old = yield* Stream.toPull(b.streamStatus({ cwd: "/repo", includeRemote: false })).pipe(
      Scope.provide(oldScope),
    );
    yield* old;
    yield* Scope.close(oldScope, Exit.void);
    state.currentLocalStatus = {
      ...baseLocalStatus,
      workingTree: { files: [], insertions: 42, deletions: 0 },
    };
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    state.beforeInvalidate = Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(resume)),
    );
    const refresh = yield* b.refreshBranchStatus({ cwd: "/repo" }).pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    const snapshotFiber = yield* Stream.runHead(
      b.streamStatus({ cwd: "/repo", includeRemote: false }),
    ).pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(refresh);
    assert.deepEqual(
      yield* Fiber.join(snapshotFiber),
      Option.some({ _tag: "snapshot" as const, local: state.currentLocalStatus, remote: null }),
    );
  }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
});
it.effect("serializes branch reads with detailed refresh publication", () => {
  const state = newState();
  return Effect.gen(function* () {
    const b = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    state.branchRead = () =>
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(resume)),
        Effect.as("old"),
      );
    const older = yield* b.refreshBranchStatus({ cwd: "/repo" }).pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    state.currentLocalStatus = { ...baseLocalStatus, refName: "new" };
    const newer = yield* b
      .refreshLocalStatus("/repo")
      .pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(older);
    yield* Fiber.join(newer);
    state.branchRead = () => Effect.succeed("new");
    const result = yield* b.getStatus({ cwd: "/repo" });
    assert.equal(result.refName, "new");
    assert.equal(state.localStatusCalls, 1);
  }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
});

it.effect("publishes overlapping branch reads in checkout order", () => {
  const state = newState();
  return Effect.gen(function* () {
    const b = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const branches = yield* Stream.toPull(b.streamBranchStatus({ cwd: "/repo" }));
    yield* branches;
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let reads = 0;
    state.branchRead = () =>
      ++reads === 1
        ? Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(resume)),
            Effect.as("old"),
          )
        : Effect.succeed("new");
    const older = yield* b.refreshBranchStatus({ cwd: "/repo" }).pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    const newer = yield* b
      .refreshBranchStatus({ cwd: "/repo" })
      .pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(older);
    yield* Fiber.join(newer);
    assert.deepEqual(yield* branches, [{ refName: "old" }, { refName: "new" }]);
  }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
});

it.effect("does not replay older queued branches after a new subscriber snapshot", () => {
  const state = newState();
  return Effect.gen(function* () {
    const b = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const values = yield* Queue.unbounded<{ readonly refName: string | null }>();
    let reads = 0;
    state.branchRead = () =>
      ++reads === 1
        ? Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(resume)),
            Effect.as("old"),
          )
        : Effect.succeed("new");
    const older = yield* b.refreshBranchStatus({ cwd: "/repo" }).pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    const subscriber = yield* b.streamBranchStatus({ cwd: "/repo" }).pipe(
      Stream.tap((value) => Queue.offer(values, value)),
      Stream.take(2),
      Stream.runDrain,
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(older);
    assert.deepEqual(yield* Queue.take(values), { refName: "new" });
    state.branchRead = () => Effect.succeed("latest");
    yield* b.refreshBranchStatus({ cwd: "/repo" });
    assert.deepEqual(yield* Queue.take(values), { refName: "latest" });
    yield* Fiber.join(subscriber);
  }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
});
