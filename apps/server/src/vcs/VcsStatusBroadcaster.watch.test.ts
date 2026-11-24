import * as NodeEvents from "node:events";
import { assert, it, describe } from "@effect/vitest";
import type { VcsBranchStatus, VcsStatusRemoteResult, VcsStatusResult } from "@goat/contracts";
import { applyGitStatusStreamEvent } from "@goat/shared/git";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { NativeHeadWatch } from "./headWatchSignals.ts";
import * as GitFixture from "./testing/gitFixture.ts";
import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";
import {
  baseLocalStatus,
  baseRemoteStatus,
  layerTestFor,
  remoteStatusWithPr,
} from "./vcsStatusBroadcaster.testkit.ts";

function fakeNativeWatch(onClose = () => {}) {
  let onEvent: ((event: string, filename: string | null) => void) | undefined;
  const watcher = Object.assign(new NodeEvents.EventEmitter(), {
    close: onClose,
    ref: () => watcher,
    unref: () => watcher,
  });
  return {
    startWatch: (
      _path: string,
      notify: NonNullable<typeof onEvent>,
      onError: (error: Error) => void,
    ) => {
      onEvent = notify;
      return watcher.on("error", onError);
    },
    notify(event: "rename" | "change", filename: string | null) {
      if (onEvent === undefined) throw new Error("The Git directory is not watched");
      onEvent(event, filename);
    },
  };
}

describe("VCS HEAD watchers", () => {
  it.effect("a terminal commit clears local Changes totals", () =>
    Effect.gen(function* () {
      const native = fakeNativeWatch();
      const state = {
        currentLocalStatus: {
          ...baseLocalStatus,
          refName: "main",
          hasWorkingTreeChanges: true,
          workingTree: {
            files: [{ path: "lib.txt", insertions: 40, deletions: 0 }],
            insertions: 40,
            deletions: 0,
          },
        },
        currentRemoteStatus: null,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
        headPath: "/repo/.git/HEAD",
        fileSystem: FileSystem.makeNoop({
          realPath: (target) => Effect.succeed(target),
          exists: () => Effect.succeed(true),
        }),
      };
      yield* Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const subscribed = yield* Deferred.make<void>();
        const clean = yield* Deferred.make<void>();
        let latest: VcsStatusResult | null = null;
        yield* Stream.runForEach(
          broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
          (event) =>
            Effect.gen(function* () {
              latest = applyGitStatusStreamEvent(latest, event);
              yield* Deferred.succeed(subscribed, undefined);
              if (latest.workingTree.files.length === 0) yield* Deferred.succeed(clean, undefined);
            }),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(subscribed);
        state.currentLocalStatus = { ...baseLocalStatus, refName: "main" };
        native.notify("rename", "index");
        yield* Deferred.await(clean);
      }).pipe(
        Effect.provide(layerTestFor(state)),
        Effect.provideService(NativeHeadWatch, native.startWatch),
        Effect.scoped,
      );
    }),
  );

  it.effect("a terminal checkout publishes the new branch without waiting for a poll", () =>
    Effect.gen(function* () {
      const native = fakeNativeWatch();
      const state = {
        currentLocalStatus: { ...baseLocalStatus, isDefaultRef: true, refName: "main" },
        currentRemoteStatus: remoteStatusWithPr as VcsStatusRemoteResult | null,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
        remoteStatusRefreshUpstreamValues: [] as Array<boolean | undefined>,
        headPath: "/repo/.git/HEAD",
        fileSystem: FileSystem.makeNoop({
          realPath: (target) => Effect.succeed(target),
          exists: () => Effect.succeed(true),
        }),
      };

      yield* Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        yield* broadcaster.getStatus({ cwd: "/repo" });
        const clientStates: Array<VcsStatusResult> = [];
        const subscribed = yield* Deferred.make<void>();
        const reconciled = yield* Deferred.make<void>();
        yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) =>
          Effect.gen(function* () {
            const next = applyGitStatusStreamEvent(clientStates.at(-1) ?? null, event);
            clientStates.push(next);
            yield* Deferred.succeed(subscribed, undefined);
            if (
              next.refName === "repro" &&
              event._tag === "remoteUpdated" &&
              event.remote !== null
            ) {
              yield* Deferred.succeed(reconciled, undefined);
            }
          }),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(subscribed);

        const remoteReadsBeforeCheckout = state.remoteStatusRefreshUpstreamValues.length;
        state.currentLocalStatus = { ...baseLocalStatus, isDefaultRef: false, refName: "repro" };
        state.currentRemoteStatus = { ...baseRemoteStatus, hasUpstream: false };
        native.notify("rename", "HEAD");
        yield* Deferred.await(reconciled);

        for (const status of clientStates.filter((status) => status.refName === "repro")) {
          assert.isNull(status.pr);
        }
        const checkoutRefreshes =
          state.remoteStatusRefreshUpstreamValues.slice(remoteReadsBeforeCheckout);
        assert.isNotEmpty(checkoutRefreshes);
        for (const refreshUpstream of checkoutRefreshes) {
          assert.isFalse(refreshUpstream);
        }
      }).pipe(
        Effect.provide(layerTestFor(state)),
        Effect.provideService(NativeHeadWatch, native.startWatch),
        Effect.scoped,
      );
    }),
  );

  it.effect("a terminal checkout updates branch-only subscribers without full status", () =>
    Effect.gen(function* () {
      const native = fakeNativeWatch();
      const state = {
        currentLocalStatus: { ...baseLocalStatus, refName: "main" },
        currentRemoteStatus: null,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
        headPath: "/repo/.git/HEAD",
        fileSystem: FileSystem.makeNoop({
          realPath: (target) => Effect.succeed(target),
          exists: () => Effect.succeed(true),
        }),
      };

      yield* Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const subscribed = yield* Deferred.make<VcsBranchStatus>();
        const checkedOut = yield* Deferred.make<VcsBranchStatus>();
        yield* Stream.runForEach(broadcaster.streamBranchStatus({ cwd: "/repo" }), (branch) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(subscribed, branch);
            if (branch.refName === "repro") yield* Deferred.succeed(checkedOut, branch);
          }),
        ).pipe(Effect.forkScoped);
        assert.deepEqual(yield* Deferred.await(subscribed), { refName: "main", isRepo: true });

        state.currentLocalStatus = { ...baseLocalStatus, refName: "repro" };
        native.notify("rename", "HEAD");

        assert.deepEqual(yield* Deferred.await(checkedOut), { refName: "repro", isRepo: true });
        assert.equal(state.localStatusCalls, 0);
      }).pipe(
        Effect.provide(layerTestFor(state)),
        Effect.provideService(NativeHeadWatch, native.startWatch),
        Effect.scoped,
      );
    }),
  );

  it.effect("a terminal checkout updates the branch before pending detailed status completes", () =>
    Effect.gen(function* () {
      const native = fakeNativeWatch();
      const state: Parameters<typeof layerTestFor>[0] = {
        currentLocalStatus: { ...baseLocalStatus, refName: "main" },
        currentRemoteStatus: null,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
        headPath: "/repo/.git/HEAD",
        fileSystem: FileSystem.makeNoop({
          realPath: (target) => Effect.succeed(target),
          exists: () => Effect.succeed(true),
        }),
      };

      yield* Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const branches = yield* Stream.toPull(broadcaster.streamBranchStatus({ cwd: "/repo" }));
        yield* branches;
        const details = yield* Stream.toPull(
          broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
        );
        yield* details;

        const detailedReadStarted = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        state.beforeLocalStatus = Deferred.succeed(detailedReadStarted, undefined).pipe(
          Effect.andThen(Deferred.await(resume)),
        );
        state.currentLocalStatus = { ...baseLocalStatus, refName: "repro" };
        native.notify("rename", "HEAD");

        assert.deepEqual(yield* branches, [{ refName: "repro", isRepo: true }]);
        yield* Deferred.await(detailedReadStarted);
        state.currentLocalStatus = { ...baseLocalStatus, refName: "second" };
        native.notify("rename", "HEAD");
        assert.deepEqual(yield* branches, [{ refName: "second", isRepo: true }]);
        yield* Deferred.succeed(resume, undefined);
      }).pipe(
        Effect.provide(layerTestFor(state)),
        Effect.provideService(NativeHeadWatch, native.startWatch),
        Effect.scoped,
      );
    }),
  );

  it.effect("a checkout read that fails while index.lock is held retries until it succeeds", () =>
    Effect.gen(function* () {
      const native = fakeNativeWatch();
      const failed = yield* Deferred.make<void>();
      const state = {
        currentLocalStatus: { ...baseLocalStatus, isDefaultRef: true, refName: "main" },
        currentRemoteStatus: null,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
        headPath: "/repo/.git/HEAD",
        fileSystem: FileSystem.makeNoop({
          realPath: (target) => Effect.succeed(target),
          exists: () => Effect.succeed(true),
        }),
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
        native.notify("rename", "HEAD");
        yield* Deferred.await(failed);
        const failedCalls = state.localStatusCalls;

        // Removing index.lock moves no HEAD, and no remote poll runs for this subscriber.
        state.failLocalStatus = false;
        yield* TestClock.adjust(Duration.seconds(30));
        yield* Deferred.await(checkedOut);
        assert.strictEqual(state.localStatusCalls, failedCalls + 1);
      }).pipe(
        Effect.provide(layerTestFor(state)),
        Effect.provideService(NativeHeadWatch, native.startWatch),
        Effect.scoped,
      );
    }),
  );

  it.effect("subscribers share one HEAD watch that ends with the last of them", () =>
    Effect.gen(function* () {
      const native = fakeNativeWatch();
      const state = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: baseRemoteStatus as VcsStatusRemoteResult | null,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
        headPath: "/repo/.git/HEAD",
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
      }).pipe(
        Effect.provide(layerTestFor(state)),
        Effect.provideService(NativeHeadWatch, native.startWatch),
        Effect.scoped,
      );
    }),
  );

  it.effect("a HEAD watch that ended restarts for the next subscriber and keeps earlier ones", () =>
    Effect.gen(function* () {
      const native = fakeNativeWatch();
      const state: Parameters<typeof layerTestFor>[0] = {
        currentLocalStatus: { ...baseLocalStatus, isDefaultRef: true, refName: "main" },
        currentRemoteStatus: null,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
        headPathCalls: 0,
        fileSystem: FileSystem.makeNoop({
          realPath: (target) => Effect.succeed(target),
          exists: () => Effect.succeed(true),
        }),
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
        const checkout = (refName: string) => {
          state.currentLocalStatus = { ...baseLocalStatus, isDefaultRef: false, refName };
          native.notify("rename", "HEAD");
        };

        // The repository has no HEAD yet, so the first watch ends at once.
        const first = yield* subscribe;
        state.headPath = "/repo/.git/HEAD";
        const second = yield* subscribe;
        assert.strictEqual(state.headPathCalls, 2);

        checkout("one");
        yield* Deferred.await(first.sawRef("one"));
        yield* Deferred.await(second.sawRef("one"));

        // The replacement belongs to both subscribers, so the second leaving keeps it.
        yield* Fiber.interrupt(second.fiber);
        checkout("two");
        yield* Deferred.await(first.sawRef("two"));
      }).pipe(
        Effect.provide(layerTestFor(state)),
        Effect.provideService(NativeHeadWatch, native.startWatch),
        Effect.scoped,
      );
    }),
  );
  it.effect("a HEAD watch ends when its git directory is removed", () =>
    Effect.gen(function* () {
      const gitDir = "/repo/.git/worktrees/feature";
      const closed = yield* Deferred.make<void>();
      const native = fakeNativeWatch(() => Deferred.doneUnsafe(closed, Effect.void));
      let gitDirExists = true;
      const state: Parameters<typeof layerTestFor>[0] = {
        currentLocalStatus: { ...baseLocalStatus, refName: "main" },
        currentRemoteStatus: null,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
        headPath: `${gitDir}/HEAD`,
        fileSystem: FileSystem.makeNoop({
          realPath: (target) => Effect.succeed(target),
          exists: (target) => Effect.succeed(target !== gitDir || gitDirExists),
        }),
      };

      yield* Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const branches = yield* Stream.toPull(broadcaster.streamBranchStatus({ cwd: "/repo" }));
        assert.deepEqual(yield* branches, [{ refName: "main", isRepo: true }]);

        // Every checkout removes HEAD.lock, which leaves the watch running.
        state.currentLocalStatus = { ...baseLocalStatus, refName: "other" };
        native.notify("rename", "HEAD.lock");
        native.notify("change", "HEAD");
        assert.deepEqual(yield* branches, [{ refName: "other", isRepo: true }]);

        // `git worktree remove` deletes the watched directory; Windows keeps reporting it.
        gitDirExists = false;
        state.currentLocalStatus = { ...baseLocalStatus, isRepo: false, refName: null };
        native.notify("rename", gitDir);
        assert.deepEqual(yield* branches, [{ refName: null, isRepo: false }]);
        yield* Deferred.await(closed);
        assert.strictEqual(state.localStatusCalls, 0);
        assert.strictEqual(state.remoteStatusCalls, 0);
      }).pipe(
        Effect.provide(layerTestFor(state)),
        Effect.provideService(NativeHeadWatch, native.startWatch),
        Effect.scoped,
      );
    }),
  );
  it.effect("coalesces native rename churn before probing the Git directory", () =>
    Effect.gen(function* () {
      const gitDir = "/repo/.git";
      const native = fakeNativeWatch();
      let probes = 0;
      const state: Parameters<typeof layerTestFor>[0] = {
        currentLocalStatus: { ...baseLocalStatus, refName: "main" },
        currentRemoteStatus: null,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
        headPath: gitDir + "/HEAD",
        fileSystem: FileSystem.makeNoop({
          realPath: (target) => Effect.succeed(target),
          exists: () =>
            Effect.sync(() => {
              probes++;
              return true;
            }),
        }),
      };
      yield* Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const branches = yield* Stream.toPull(broadcaster.streamBranchStatus({ cwd: "/repo" }));
        assert.deepEqual(yield* branches, [{ refName: "main", isRepo: true }]);
        state.currentLocalStatus = { ...baseLocalStatus, refName: "topic" };
        yield* Effect.sync(() => {
          for (let index = 0; index < 64; index++) {
            native.notify("rename", "HEAD.lock");
          }
          native.notify("change", "HEAD");
        });
        assert.deepEqual(yield* branches, [{ refName: "topic", isRepo: true }]);
        assert.strictEqual(probes, 1);
        assert.strictEqual(state.localStatusCalls, 0);
      }).pipe(
        Effect.provide(layerTestFor(state)),
        Effect.provideService(NativeHeadWatch, native.startWatch),
        Effect.scoped,
      );
    }),
  );
  it.effect(
    "publishes native linked worktree removal during HEAD.lock churn and closes the watch",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "vcs-linked-head-watch-" });
        const main = path.join(root, "main");
        const linked = path.join(root, "linked");
        yield* fs.makeDirectory(main);
        yield* GitFixture.git(main, ["init", "-b", "main"]);
        yield* GitFixture.git(main, [
          "-c",
          "user.email=t@t",
          "-c",
          "user.name=t",
          "commit",
          "--allow-empty",
          "-m",
          "init",
        ]);
        yield* GitFixture.git(main, ["worktree", "add", "-b", "topic", linked]);
        const headPath = yield* GitFixture.git(linked, [
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          "HEAD",
        ]);

        const adminDir = path.dirname(headPath);
        const pendingProbe = yield* Deferred.make<void>();
        const permitProbe = yield* Deferred.make<void>();
        let removing = false;
        const closed = yield* Deferred.make<void>();
        const startWatch = yield* NativeHeadWatch;
        const state: Parameters<typeof layerTestFor>[0] = {
          currentLocalStatus: { ...baseLocalStatus, refName: "topic" },
          currentRemoteStatus: null,
          localStatusCalls: 0,
          remoteStatusCalls: 0,
          localInvalidationCalls: 0,
          remoteInvalidationCalls: 0,
          headPath,
          fileSystem: {
            ...fs,
            exists: (target) =>
              removing && target === adminDir
                ? Deferred.succeed(pendingProbe, undefined).pipe(
                    Effect.andThen(Deferred.await(permitProbe)),
                    Effect.andThen(fs.exists(target)),
                  )
                : fs.exists(target),
          },
          branchRead: () =>
            fs.readFileString(headPath).pipe(
              Effect.map((contents) => contents.trim().replace(/^ref: refs\/heads\//, "")),
              Effect.orElseSucceed(() => {
                state.currentLocalStatus = { ...baseLocalStatus, isRepo: false, refName: null };
                return null;
              }),
            ),
        };

        yield* Effect.gen(function* () {
          const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
          const branches = yield* Stream.toPull(broadcaster.streamBranchStatus({ cwd: linked }));
          assert.deepEqual(yield* branches, [{ refName: "topic", isRepo: true }]);

          const lock = headPath + ".lock";
          for (let index = 0; index < 8; index++) {
            yield* fs.writeFileString(lock, "ref: refs/heads/topic\n");
            yield* fs.remove(lock);
          }
          yield* GitFixture.git(linked, ["symbolic-ref", "HEAD", "refs/heads/other"]);

          assert.deepEqual(yield* branches, [{ refName: "other", isRepo: true }]);

          assert.isFalse(yield* Deferred.isDone(closed));

          removing = true;
          yield* fs.writeFileString(lock, "ref: refs/heads/other\n");
          yield* Deferred.await(pendingProbe);
          yield* GitFixture.git(main, ["worktree", "remove", "--force", linked]);
          yield* Deferred.succeed(permitProbe, undefined);

          assert.deepEqual(yield* branches, [{ refName: null, isRepo: false }]);
          yield* Deferred.await(closed);
          assert.strictEqual(state.localStatusCalls, 0);
          assert.strictEqual(state.remoteStatusCalls, 0);
        }).pipe(
          Effect.provide(layerTestFor(state)),
          Effect.provideService(NativeHeadWatch, (directory, notify, onError) => {
            const watcher = startWatch(directory, notify, onError);
            watcher.once("close", () => Deferred.doneUnsafe(closed, Effect.void));
            return watcher;
          }),
        );
      }).pipe(Effect.provide(GitFixture.layerTest), Effect.scoped),
  );
});
