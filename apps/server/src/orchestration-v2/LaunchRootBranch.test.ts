import { GitCommandError } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { makeHarness } from "./testkit/ThreadLaunchHarness.ts";
import { launchInput } from "./testkit/threadLaunchInput.ts";

it.effect("records the checkout branch on a root launch that names none", () => {
  const harness = makeHarness({
    git: { currentBranch: () => Effect.succeed("fix/checkout-total") },
  });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const launched = yield* launches.launch(
      launchInput({ command: "command:root-branch", thread: "thread:root-branch" }),
    );
    const threads = yield* ThreadManagement.ThreadManagementService;
    assert.equal(
      (yield* threads.getThreadProjection(launched.threadId)).thread.branch,
      "fix/checkout-total",
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("reports branch detection failures without creating a thread", () => {
  const harness = makeHarness({
    git: {
      currentBranch: () =>
        Effect.fail(
          new GitCommandError({
            operation: "currentBranch",
            command: "git",
            cwd: "/repo",
            detail: "failed",
          }),
        ),
    },
  });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const failure = yield* launches
      .launch(launchInput({ command: "command:branch-failure", thread: "thread:branch-failure" }))
      .pipe(Effect.flip);
    assert.instanceOf(failure, ThreadLaunch.ThreadLaunchError);
    assert.equal(failure.operation, "resolve-project");
  }).pipe(Effect.provide(harness.layer));
});
