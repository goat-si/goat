import { assert, it, describe } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { VcsStatusRemoteResult } from "@goat/contracts";
import { GitManagerError } from "@goat/contracts";

import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";
import {
  baseLocalStatus,
  baseRemoteStatus,
  layerTestFor,
  remoteStatusWithPr,
} from "./vcsStatusBroadcaster.testkit.ts";

describe("VcsStatusBroadcaster local-only refresh", () => {
  it.effect("turn-end PR lookup reuses the preceding divergence read once", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      remoteStatusReusedDetails: [],
    };
    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      yield* broadcaster.refreshLocalStatus("/repo");
      yield* broadcaster.refreshPullRequestStatus("/repo");
      yield* broadcaster.refreshPullRequestStatus("/repo");
      assert.deepStrictEqual(state.remoteStatusReusedDetails, [false, true, false]);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect("a local-only refresh that overlaps the first remote poll keeps its PR", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const pollStarted = yield* Deferred.make<void>();
      const releasePoll = yield* Deferred.make<void>();
      state.beforeRemoteStatus = Deferred.succeed(pollStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releasePoll)),
      );
      const localSeen = yield* Deferred.make<void>();
      yield* broadcaster.streamStatus({ cwd: "/repo" }).pipe(
        Stream.runForEach((event) =>
          event._tag === "localUpdated" ? Deferred.succeed(localSeen, undefined) : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(pollStarted);
      state.beforeRemoteStatus = Effect.void;

      state.currentLocalStatus = { ...baseLocalStatus, hasWorkingTreeChanges: true };
      const refresh = yield* broadcaster
        .refreshStatus("/repo", { localOnly: true })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(localSeen);
      yield* Deferred.succeed(releasePoll, undefined);
      yield* Fiber.join(refresh);

      const status = yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.deepStrictEqual(status.pr, remoteStatusWithPr.pr);
      assert.equal(state.remoteStatusCalls, 1);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect(
    "a local-only refresh before any remote read leaves the PR refresh able to read",
    () => {
      const state: Parameters<typeof layerTestFor>[0] = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: remoteStatusWithPr,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };

      return Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        yield* broadcaster.refreshStatus("/repo", { localOnly: true });

        const remote = yield* broadcaster.refreshPullRequestStatus("/repo");
        assert.deepStrictEqual(remote?.pr, remoteStatusWithPr.pr);
        assert.equal(state.remoteStatusCalls, 1);
      }).pipe(Effect.provide(layerTestFor(state)));
    },
  );

  it.effect("a local-only refresh after a branch switch leaves the PR refresh able to read", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });

      state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/next" };
      const nextBranchRemote: VcsStatusRemoteResult = {
        ...baseRemoteStatus,
        pr: { ...remoteStatusWithPr.pr!, number: 3001, headRef: "feature/next" },
      };
      state.currentRemoteStatus = nextBranchRemote;
      yield* broadcaster.refreshStatus("/repo", { localOnly: true });

      const remote = yield* broadcaster.refreshPullRequestStatus("/repo");
      assert.deepStrictEqual(remote?.pr, nextBranchRemote.pr);
      assert.equal(state.remoteStatusCalls, 2);
    }).pipe(Effect.provide(layerTestFor(state)));
  });
});

describe("VcsStatusBroadcaster full refresh", () => {
  it.effect("shutting down during refresh admission settles the caller", () =>
    Effect.forEach(
      Array.from({ length: 16 }, (_, index) => index + 1),
      (pauseAt) =>
        Effect.gen(function* () {
          const layerScope = yield* Scope.fork(yield* Effect.scope);
          const state = {
            currentLocalStatus: baseLocalStatus,
            currentRemoteStatus: baseRemoteStatus,
            localStatusCalls: 0,
            remoteStatusCalls: 0,
            localInvalidationCalls: 0,
            remoteInvalidationCalls: 0,
            fileSystem: FileSystem.makeNoop({ realPath: (cwd) => Effect.succeed(cwd) }),
          };
          const context = yield* Layer.buildWithScope(layerTestFor(state), layerScope);
          const broadcaster = Context.get(context, VcsStatusBroadcaster.VcsStatusBroadcaster);
          let caller: number | undefined;
          let callerOps = 0;
          let park = false;
          let resume: (() => void) | undefined;
          const defaults = new Scheduler.MixedScheduler();
          const scheduler = new Scheduler.MixedScheduler("async", (run) => {
            if (!park) return defaults.setImmediate(run);
            park = false;
            resume = run;
            return () => {};
          });
          scheduler.shouldYield = (fiber) => {
            park = fiber.id === caller && ++callerOps === pauseAt;
            return park;
          };
          const request = yield* Effect.withFiber((fiber) => {
            caller = fiber.id;
            return broadcaster.refreshStatus("/repo");
          }).pipe(
            Effect.provideService(Scheduler.Scheduler, scheduler),
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* Scope.close(layerScope, Exit.void);
          if (resume === undefined) return;
          resume();
          const result = request.pollUnsafe();
          assert.isDefined(result, `request stayed pending at admission yield ${pauseAt}`);
          if (state.localStatusCalls === 0) {
            assert.isTrue(result !== undefined && Exit.hasInterrupts(result));
          }
        }),
      { discard: true },
    ),
  );

  it.effect.each(["succeeds", "fails"] as const)(
    "overlapping callers share a fresh follow-up when the running refresh %s",
    (outcome) => {
      const state: Parameters<typeof layerTestFor>[0] = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: baseRemoteStatus,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
        fileSystem: FileSystem.makeNoop({ realPath: (cwd) => Effect.succeed(cwd) }),
      };
      const remoteError = new GitManagerError({
        operation: "VcsStatusBroadcaster.test",
        cwd: "/repo",
        detail: "remote status failed",
      });

      return Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        state.beforeRemoteStatus = Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(outcome === "fails" ? Effect.fail(remoteError) : Effect.void),
        );
        const refresh = broadcaster.refreshStatus("/repo");
        const first = yield* refresh.pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(started);
        state.beforeRemoteStatus = Effect.sync(() => {
          state.currentRemoteStatus = remoteStatusWithPr;
        });
        const forkRefresh = refresh.pipe(Effect.forkScoped({ startImmediately: true }));
        const cancelled = yield* forkRefresh;
        const second = yield* forkRefresh;
        const third = yield* forkRefresh;
        yield* Fiber.interrupt(cancelled);
        yield* broadcaster.refreshStatus("/repo", { localOnly: true });
        yield* Deferred.succeed(release, undefined);

        const initial = yield* Fiber.join(first);
        if (outcome === "fails") {
          assert.strictEqual(initial._tag === "Failure" && initial.failure, remoteError);
        } else {
          assert.isNull(initial._tag === "Success" && initial.success.pr);
        }
        assert.deepEqual((yield* Fiber.join(second)).pr, remoteStatusWithPr.pr);
        assert.deepEqual((yield* Fiber.join(third)).pr, remoteStatusWithPr.pr);
        const completedReads = outcome === "fails" ? 1 : 2;
        assert.equal(state.remoteStatusCalls, completedReads);

        yield* refresh;
        assert.equal(state.remoteStatusCalls, completedReads + 1);
      }).pipe(Effect.provide(layerTestFor(state)));
    },
  );

  it.effect("cancelled aliases cannot exceed the refresh worker limit", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      fileSystem: FileSystem.makeNoop({ realPath: () => Effect.succeed("/repo") }),
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      state.beforeRemoteStatus = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const running = yield* broadcaster.refreshStatus("/repo").pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* Effect.forEach(
        Array.from({ length: 15 }, (_, index) => `/alias/${index}`),
        (cwd) =>
          broadcaster
            .refreshStatus(cwd)
            .pipe(Effect.forkScoped({ startImmediately: true }), Effect.flatMap(Fiber.interrupt)),
        { discard: true },
      );

      const existing = yield* broadcaster
        .refreshStatus("/repo")
        .pipe(Effect.forkScoped({ startImmediately: true }));
      const overflow = yield* broadcaster
        .refreshStatus("/overflow")
        .pipe(Effect.result, Effect.forkScoped({ startImmediately: true }));
      const result = overflow.pollUnsafe();
      assert.isTrue(
        result?._tag === "Success" &&
          result.value._tag === "Failure" &&
          result.value.failure._tag === "GitManagerError",
        "excess raw checkout must fail immediately with a GitManagerError",
      );

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(running);
      yield* Fiber.join(existing);
      assert.equal(state.remoteStatusCalls, 17);
      yield* broadcaster.refreshStatus("/overflow");
      assert.equal(state.remoteStatusCalls, 18);
    }).pipe(Effect.provide(layerTestFor(state)));
  });
});
