import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { makeHarness } from "./testkit/ThreadLaunchHarness.ts";
import { launchInput } from "./testkit/threadLaunchInput.ts";

const cases = (["before", "during", "after"] as const).flatMap((when) =>
  [false, true].map((reused) => ({ when, reused })),
);

it.effect.each(cases)(
  "cancel $when release preserves ownership (reused=$reused)",
  ({ when, reused }) =>
    Effect.gen(function* () {
      const setupWaiting = yield* Deferred.make<void>();
      const releaseCommitted = yield* Deferred.make<void>();
      const acknowledgeRelease = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const history = new Map([["setup", "synthetic setup output"]]);
      const reuseOptions: Parameters<typeof makeHarness>[0] = reused
        ? {
            createWorktree: (input, options) =>
              (
                options?.progress?.onExistingBranch?.({
                  worktree: "reused",
                  fastForwarded: true,
                }) ?? Effect.void
              ).pipe(
                Effect.as({
                  worktree: { path: "/repo-worktrees/leftover", refName: input.newRefName! },
                }),
              ),
          }
        : {};
      const harness = makeHarness({
        ...reuseOptions,
        afterRelease: Deferred.succeed(releaseCommitted, undefined).pipe(
          Effect.andThen(when === "during" ? Deferred.await(acknowledgeRelease) : Effect.void),
        ),
        runSetup: () =>
          Effect.succeed({
            status: "started" as const,
            async: when !== "before",
            scriptId: "setup",
            scriptName: "Setup",
            scriptCommand: "prepare",
            terminalId: "setup",
            cwd: reused ? "/repo-worktrees/leftover" : "/repo-worktrees/feature",
            completion: Deferred.succeed(setupWaiting, undefined).pipe(
              Effect.andThen(Effect.never),
            ),
          }),
        closeTerminal: (input) =>
          Effect.sync(() => {
            if (input.deleteHistory) history.delete(input.terminalId);
          }),
      });
      yield* Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
        const input = launchInput({
          command: `safety-${when}-${reused}`,
          thread: `safety-${when}-${reused}`,
          message: "Synthetic launch",
          workspace: { type: "worktree", baseRef: "main", branch: "fix/safety" },
        });
        const launched = yield* launches.launch(input);
        try {
          if (when === "before") yield* Deferred.await(setupWaiting);
          else yield* Deferred.await(releaseCommitted);
          if (when === "after")
            yield* tracker.stream(launched.threadId).pipe(
              Stream.filter(
                (snapshot) =>
                  snapshot?.stages.some(
                    (stage) => stage.id === "agent" && stage.status === "done",
                  ) === true,
              ),
              Stream.runHead,
            );
          const before = yield* threads.getThreadProjection(launched.threadId);
          const cancel = yield* tracker
            .cancel(launched.threadId)
            .pipe(Effect.ensuring(Deferred.succeed(cancelled, undefined)), Effect.forkScoped);
          if (when === "during") {
            yield* TestClock.adjust("0 millis");
            assert.isFalse(yield* Deferred.isDone(cancelled));
            assert.equal(
              (yield* threads.getThreadProjection(launched.threadId)).runs[0]?.status,
              "starting",
            );
            yield* Deferred.succeed(acknowledgeRelease, undefined);
          }
          assert.isTrue(yield* Fiber.join(cancel));
          assert.equal((yield* tracker.get(launched.threadId))?.phase, "cancelled");
          const released = when !== "before";
          assert.equal(harness.closeTerminal.mock.calls.length, 1);
          assert.equal(harness.closeTerminal.mock.calls[0]?.[0].deleteHistory, !released);
          assert.equal(history.has("setup"), released);
          assert.equal(harness.removeWorktree.mock.calls.length, !released && !reused ? 1 : 0);
          assert.equal(harness.deleteLocalBranch.mock.calls.length, !released && !reused ? 1 : 0);
          const after = yield* threads.getThreadProjection(launched.threadId);
          assert.equal(after.runs[0]?.status, released ? "starting" : "failed");
          if (released || reused) {
            assert.equal(after.thread.worktreePath, before.thread.worktreePath);
            assert.equal(after.thread.branch, before.thread.branch);
          }
          if (!released && !reused) {
            assert.isNull(after.thread.worktreePath);
            assert.isNull(after.thread.branch);
          }
          assert.isFalse(yield* tracker.cancel(launched.threadId));
        } finally {
          yield* Deferred.succeed(acknowledgeRelease, undefined);
        }
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
);
