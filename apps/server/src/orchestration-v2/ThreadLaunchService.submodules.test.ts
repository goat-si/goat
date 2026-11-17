import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import { makeHarness } from "./testkit/ThreadLaunchHarness.ts";
import { launchInput } from "./testkit/threadLaunchInput.ts";

it.effect("reports submodule downloads as their own setup step", () =>
  Effect.gen(function* () {
    const progressReady =
      yield* Deferred.make<
        NonNullable<
          NonNullable<
            Parameters<GitWorkflow.GitWorkflowService["Service"]["createWorktree"]>[1]
          >["progress"]
        >
      >();
    const release = yield* Deferred.make<void>();
    const harness = makeHarness({
      createWorktree: (input, options) =>
        Deferred.succeed(progressReady, options?.progress ?? {}).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as({
            worktree: {
              path: "/repo-worktrees/feature",
              refName: input.newRefName,
              headSha: "abc",
            },
          } as never),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
      const launched = yield* launches.launch(
        launchInput({
          command: "launch:submodule-progress",
          thread: "thread:submodule-progress",
          message: "Start",
          workspace: { type: "worktree", baseRef: "main" },
        }),
      );
      const stage = (id: string) =>
        tracker
          .get(launched.threadId)
          .pipe(Effect.map((snapshot) => snapshot?.stages.find((entry) => entry.id === id)));
      const progress = yield* Deferred.await(progressReady);
      const line = (text: string) => progress.onSubmoduleLine?.(text) ?? Effect.void;

      yield* progress.onSubmodulesStarted?.() ?? Effect.void;
      yield* line("Receiving objects:  20% (2/10), 4.00 MiB | 1.50 MiB/s");
      yield* line("Receiving objects:  30% (3/10), 6.00 MiB | 1.50 MiB/s");
      assert.equal((yield* stage("checkout"))?.status, "done");
      assert.deepInclude(yield* stage("submodules"), {
        status: "running",
        detail: "Receiving objects: 20% (2/10), 4.00 MiB | 1.50 MiB/s",
      });

      yield* TestClock.adjust("1 second");
      yield* line("Receiving objects:  60% (6/10), 12.00 MiB | 1.50 MiB/s");
      assert.equal(
        (yield* stage("submodules"))?.detail,
        "Receiving objects: 60% (6/10), 12.00 MiB | 1.50 MiB/s",
      );

      yield* line("Submodule path 'vendor/o'hare': checked out 'abc'");
      yield* progress.onSubmodulesFinished?.({ ok: true, detail: null }) ?? Effect.void;
      yield* Deferred.succeed(release, undefined);
      yield* tracker.stream(launched.threadId).pipe(
        Stream.filter((snapshot) => snapshot?.phase !== "running"),
        Stream.runHead,
      );
      assert.deepInclude(yield* stage("submodules"), {
        status: "done",
        detail: "vendor/o'hare",
      });
    }).pipe(Effect.provide(harness.layer));
  }),
);

// A worktree with no submodules leaves the step it reserved settled, not pending.
it.effect("a new worktree without submodules marks the submodule step as none", () =>
  Effect.gen(function* () {
    const harness = makeHarness({});
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const tracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
      const launched = yield* launches.launch(
        launchInput({
          command: "launch:no-submodules",
          thread: "thread:no-submodules",
          message: "Start",
          workspace: { type: "worktree", baseRef: "main" },
        }),
      );
      yield* tracker.stream(launched.threadId).pipe(
        Stream.filter((snapshot) => snapshot?.worktreePath != null),
        Stream.runHead,
      );
      const settled = yield* tracker.get(launched.threadId);
      assert.deepInclude(
        settled?.stages.find((stage) => stage.id === "submodules"),
        { status: "skipped", detail: "none" },
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);
