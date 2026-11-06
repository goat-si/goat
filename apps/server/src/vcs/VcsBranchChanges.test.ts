import { assert, it } from "@effect/vitest";
import type { VcsStatusLocalResult } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";

it.effect("retains another worktree's branch change when a slow subscriber is saturated", () => {
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
      Stream.take(258),
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
    branches.set("/a", "overflow");
    let overflowCompleted = false;
    const producer = yield* broadcaster.refreshLocalStatus("/a").pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          overflowCompleted = true;
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    assert.isFalse(overflowCompleted);
    let cancelled = false;
    const interruption = yield* Fiber.interrupt(producer).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          cancelled = true;
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    assert.isFalse(cancelled);
    yield* Deferred.succeed(release, undefined);
    const events = yield* Fiber.join(received);
    yield* Fiber.join(interruption);
    assert.deepStrictEqual(events[0], { cwd: "/a", refName: "initial" });
    assert.deepStrictEqual(events[1], { cwd: "/b", refName: "feature-b" });
    assert.deepStrictEqual(events.at(-1), { cwd: "/a", refName: "overflow" });
  }).pipe(Effect.provide(layer), Effect.scoped);
});
