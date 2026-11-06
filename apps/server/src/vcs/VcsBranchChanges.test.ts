import { assert, it } from "@effect/vitest";
import { RunId, ThreadId, type VcsStatusLocalResult } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as RunFinalization from "../orchestration-v2/RunFinalizationService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";

it.effect(
  "a stalled subscriber cannot block refresh or finalization and both worktrees converge",
  () => {
    const status = (refName: string): VcsStatusLocalResult => ({
      isRepo: true,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
    });
    const branches = new Map([
      ["/a", "initial"],
      ["/b", "feature-b"],
    ]);
    const layer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(FileSystem.layerNoop({ realPath: (path) => Effect.succeed(path) })),
      Layer.provide(Layer.mock(BackgroundPolicy.BackgroundPolicy)({})),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: ({ cwd }) => Effect.sync(() => status(branches.get(cwd) ?? "missing")),
          currentBranch: (cwd) => Effect.sync(() => branches.get(cwd) ?? null),
          invalidateLocalStatus: () => Effect.void,
        }),
      ),
    );
    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const received = yield* broadcaster.streamBranchChanges.pipe(
        Stream.tap((event) =>
          event.refName === "initial"
            ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* broadcaster.refreshLocalStatus("/a");
      yield* Deferred.await(started);
      yield* broadcaster.refreshLocalStatus("/b");
      for (let i = 0; i < 255; i++) {
        branches.set("/a", `branch-${i}`);
        yield* broadcaster.refreshLocalStatus("/a");
      }
      branches.set("/a", "final-branch");
      const finished = yield* Deferred.make<void>();
      const observerLayer = RunFinalization.layerObserver.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(VcsStatusBroadcaster.VcsStatusBroadcaster, broadcaster),
            Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
            Layer.mock(PullRequestService.PullRequestService)({
              refreshAfterTurn: () => Effect.void,
            }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThreadShell: () => Effect.succeed(null),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const observer = yield* RunFinalization.RunFinalizationObserver;
        const finalizing = yield* observer
          .refresh({ cwd: "/a", threadId: ThreadId.make("thread"), runId: RunId.make("run") })
          .pipe(
            Effect.tap(() => Deferred.succeed(finished, undefined)),
            Effect.forkScoped({ startImmediately: true }),
          );
        const completedWhileStalled = yield* Deferred.isDone(finished);
        yield* Deferred.succeed(release, undefined);
        const events = yield* Fiber.join(received);
        yield* Fiber.join(finalizing);
        assert.isTrue(completedWhileStalled);
        assert.deepStrictEqual(events, [
          { cwd: "/a", refName: "initial" },
          { cwd: "/b", refName: "feature-b" },
          { cwd: "/a", refName: "final-branch" },
        ]);
      }).pipe(Effect.provide(observerLayer));
    }).pipe(Effect.provide(layer), Effect.scoped);
  },
);

it.effect("a worktree beyond the coalescing limit is retried on its next refresh", () => {
  const branches = new Map<string, string>();
  const layer = VcsStatusBroadcaster.layer.pipe(
    Layer.provideMerge(FileSystem.layerNoop({ realPath: (path) => Effect.succeed(path) })),
    Layer.provide(Layer.mock(BackgroundPolicy.BackgroundPolicy)({})),
    Layer.provide(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        localStatus: ({ cwd }) =>
          Effect.sync(() => ({
            isRepo: true,
            hasPrimaryRemote: false,
            isDefaultRef: false,
            refName: branches.get(cwd) ?? "missing",
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          })),
        currentBranch: (cwd) => Effect.sync(() => branches.get(cwd) ?? null),
        invalidateLocalStatus: () => Effect.void,
      }),
    ),
  );
  return Effect.gen(function* () {
    const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const drained = yield* Deferred.make<void>();
    const received = yield* broadcaster.streamBranchChanges.pipe(
      Stream.tap((event) =>
        event.cwd === "/seed"
          ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : event.cwd === "/w255"
            ? Deferred.succeed(drained, undefined)
            : Effect.void,
      ),
      Stream.take(258),
      Stream.runCollect,
      Effect.forkScoped({ startImmediately: true }),
    );
    branches.set("/seed", "initial");
    yield* broadcaster.refreshLocalStatus("/seed");
    yield* Deferred.await(started);
    for (let i = 0; i <= 256; i++) {
      branches.set(`/w${i}`, "first");
      yield* broadcaster.refreshLocalStatus(`/w${i}`);
    }
    branches.set("/w256", "latest");
    yield* broadcaster.refreshLocalStatus("/w256");
    yield* Deferred.succeed(release, undefined);
    yield* Deferred.await(drained);
    yield* broadcaster.refreshLocalStatus("/w256");
    const events = yield* Fiber.join(received);
    assert.deepStrictEqual(events.at(-1), { cwd: "/w256", refName: "latest" });
  }).pipe(Effect.provide(layer), Effect.scoped);
});
