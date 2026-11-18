import { assert, it, describe } from "@effect/vitest";
import type { VcsStatusRemoteResult, VcsStatusResult } from "@goat/contracts";
import { applyGitStatusStreamEvent } from "@goat/shared/git";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";
import {
  baseLocalStatus,
  baseRemoteStatus,
  layerTestFor,
  remoteStatusWithPr,
} from "./vcsStatusBroadcaster.testkit.ts";

describe("VCS HEAD watchers", () => {
  it.effect("a terminal checkout publishes the new branch without waiting for a poll", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const gitDir = yield* fs.makeTempDirectoryScoped({ prefix: "vcs-head-watch-" });
      const headPath = path.join(gitDir, "HEAD");
      yield* fs.writeFileString(headPath, "ref: refs/heads/main\n");
      const state = {
        currentLocalStatus: { ...baseLocalStatus, isDefaultRef: true, refName: "main" },
        currentRemoteStatus: remoteStatusWithPr as VcsStatusRemoteResult | null,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
        remoteStatusRefreshUpstreamValues: [] as Array<boolean | undefined>,
        headPath,
      };

      yield* Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        yield* broadcaster.getStatus({ cwd: "/repo" });
        const clientStates: Array<VcsStatusResult> = [];
        const subscribed = yield* Deferred.make<void>();
        const checkedOut = yield* Deferred.make<void>();
        yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) =>
          Effect.gen(function* () {
            const next = applyGitStatusStreamEvent(clientStates.at(-1) ?? null, event);
            clientStates.push(next);
            yield* Deferred.succeed(subscribed, undefined);
            if (next.refName === "repro") yield* Deferred.succeed(checkedOut, undefined);
          }),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(subscribed);

        // What `git switch -c repro` does to HEAD, with the test clock never advanced.
        state.currentLocalStatus = { ...baseLocalStatus, isDefaultRef: false, refName: "repro" };
        state.currentRemoteStatus = { ...baseRemoteStatus, hasUpstream: false };
        const lockPath = path.join(gitDir, "HEAD.lock");
        yield* fs.writeFileString(lockPath, "ref: refs/heads/repro\n");
        yield* fs.rename(lockPath, headPath);
        yield* Deferred.await(checkedOut);

        assert.deepStrictEqual(
          clientStates.filter((status) => status.refName === "repro").map((status) => status.pr),
          [null],
        );
        // A checkout must not trigger a network fetch.
        assert.deepStrictEqual(state.remoteStatusRefreshUpstreamValues.slice(1), [false]);
      }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("a terminal checkout updates branch-only subscribers without full status", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const gitDir = yield* fs.makeTempDirectoryScoped({ prefix: "vcs-head-watch-" });
      const headPath = path.join(gitDir, "HEAD");
      yield* fs.writeFileString(headPath, "ref: refs/heads/main\n");
      const state = {
        currentLocalStatus: { ...baseLocalStatus, refName: "main" },
        currentRemoteStatus: null,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
        headPath,
      };

      yield* Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const branches = yield* Stream.toPull(broadcaster.streamBranchStatus({ cwd: "/repo" }));
        assert.deepEqual(yield* branches, [{ refName: "main", isRepo: true }]);

        state.currentLocalStatus = { ...baseLocalStatus, refName: "repro" };
        const lockPath = path.join(gitDir, "HEAD.lock");
        yield* fs.writeFileString(lockPath, "ref: refs/heads/repro\n");
        yield* fs.rename(lockPath, headPath);

        assert.deepEqual(yield* branches, [{ refName: "repro", isRepo: true }]);
        assert.equal(state.localStatusCalls, 0);
      }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("a checkout read that fails while index.lock is held retries until it succeeds", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const gitDir = yield* fs.makeTempDirectoryScoped({ prefix: "vcs-head-watch-" });
      const headPath = path.join(gitDir, "HEAD");
      yield* fs.writeFileString(headPath, "ref: refs/heads/main\n");
      const failed = yield* Deferred.make<void>();
      const state = {
        currentLocalStatus: { ...baseLocalStatus, isDefaultRef: true, refName: "main" },
        currentRemoteStatus: null,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
        headPath,
        failLocalStatus: false,
        onLocalStatusFailure: Deferred.succeed(failed, undefined).pipe(Effect.asVoid),
      };

      yield* Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const subscribed = yield* Deferred.make<void>();
        const checkedOut = yield* Deferred.make<void>();
        let clientState: VcsStatusResult | null = null;
        yield* Stream.runForEach(
          broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
          (event) =>
            Effect.gen(function* () {
              clientState = applyGitStatusStreamEvent(clientState, event);
              yield* Deferred.succeed(subscribed, undefined);
              if (clientState.refName === "repro") yield* Deferred.succeed(checkedOut, undefined);
            }),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(subscribed);

        // A terminal commit holds index.lock across the checkout, so the HEAD event's read fails.
        state.failLocalStatus = true;
        state.currentLocalStatus = { ...baseLocalStatus, isDefaultRef: false, refName: "repro" };
        const lockPath = path.join(gitDir, "HEAD.lock");
        yield* fs.writeFileString(lockPath, "ref: refs/heads/repro\n");
        yield* fs.rename(lockPath, headPath);
        yield* Deferred.await(failed);
        const failedCalls = state.localStatusCalls;

        // Removing index.lock moves no HEAD, and no remote poll runs for this subscriber.
        state.failLocalStatus = false;
        yield* TestClock.adjust(Duration.seconds(30));
        yield* Deferred.await(checkedOut);
        assert.strictEqual(state.localStatusCalls, failedCalls + 1);
      }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("subscribers share one HEAD watch that ends with the last of them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const gitDir = yield* fs.makeTempDirectoryScoped({ prefix: "vcs-head-watch-" });
      const headPath = path.join(gitDir, "HEAD");
      yield* fs.writeFileString(headPath, "ref: refs/heads/main\n");
      const state = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: baseRemoteStatus as VcsStatusRemoteResult | null,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
        headPath,
        headPathCalls: 0,
      };

      yield* Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const subscribe = Effect.gen(function* () {
          const received = yield* Deferred.make<void>();
          const fiber = yield* Stream.runForEach(
            broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
            () => Deferred.succeed(received, undefined),
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(received);
          return fiber;
        });

        const first = yield* subscribe;
        const second = yield* subscribe;
        assert.strictEqual(state.headPathCalls, 1);

        yield* Fiber.interrupt(first);
        yield* Fiber.interrupt(second);
        yield* subscribe;
        assert.strictEqual(state.headPathCalls, 2);
      }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("a HEAD watch that ended restarts for the next subscriber and keeps earlier ones", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const gitDir = yield* fs.makeTempDirectoryScoped({ prefix: "vcs-head-watch-" });
      const headPath = path.join(gitDir, "HEAD");
      yield* fs.writeFileString(headPath, "ref: refs/heads/main\n");
      const state: Parameters<typeof layerTestFor>[0] = {
        currentLocalStatus: { ...baseLocalStatus, isDefaultRef: true, refName: "main" },
        currentRemoteStatus: null,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
        headPathCalls: 0,
      };

      yield* Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const subscribe = Effect.gen(function* () {
          const subscribed = yield* Deferred.make<void>();
          const refs = new Map<string, Deferred.Deferred<void>>();
          const sawRef = (refName: string) => {
            const existing = refs.get(refName);
            if (existing) return existing;
            const created = Deferred.makeUnsafe<void>();
            refs.set(refName, created);
            return created;
          };
          let clientState: VcsStatusResult | null = null;
          const fiber = yield* Stream.runForEach(
            broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
            (event) =>
              Effect.gen(function* () {
                clientState = applyGitStatusStreamEvent(clientState, event);
                yield* Deferred.succeed(subscribed, undefined);
                yield* Deferred.succeed(sawRef(clientState.refName ?? ""), undefined);
              }),
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(subscribed);
          return { fiber, sawRef };
        });
        const checkout = (refName: string) =>
          Effect.gen(function* () {
            state.currentLocalStatus = { ...baseLocalStatus, isDefaultRef: false, refName };
            const lockPath = path.join(gitDir, "HEAD.lock");
            yield* fs.writeFileString(lockPath, `ref: refs/heads/${refName}\n`);
            yield* fs.rename(lockPath, headPath);
          });

        // The repository has no HEAD yet, so the first watch ends at once.
        const first = yield* subscribe;
        state.headPath = headPath;
        const second = yield* subscribe;
        assert.strictEqual(state.headPathCalls, 2);

        yield* checkout("one");
        yield* Deferred.await(first.sawRef("one"));
        yield* Deferred.await(second.sawRef("one"));

        // The replacement belongs to both subscribers, so the second leaving keeps it.
        yield* Fiber.interrupt(second.fiber);
        yield* checkout("two");
        yield* Deferred.await(first.sawRef("two"));
      }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
