import { assert, it } from "@effect/vitest";
import { ServerSettingsError, TextGenerationError } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { makeHarness } from "./testkit/ThreadLaunchHarness.ts";
import { launchInput, projectId } from "./testkit/threadLaunchInput.ts";
import { preparationSettled } from "./testkit/preparationSettled.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

it.effect.each([
  { prefix: "my-prefix", collision: null, expected: /^my-prefix\/[0-9a-f]{8}$/ },
  { prefix: "my-prefix", collision: "my-prefix", expected: /^my-prefix-[0-9a-f]{8}$/ },
  { prefix: "team/topic", collision: "team", expected: /^team-topic-[0-9a-f]{8}$/ },
])("keeps prefix '$prefix' with collision '$collision' when naming fails", (scenario) =>
  Effect.gen(function* () {
    const namingAttempted = yield* Deferred.make<void>();
    const harness = makeHarness({
      serverSettings: {
        branchNamePrefix: "global-prefix",
        projectSettingsOverrides: {
          [projectId]: { branchNamingMode: "static", branchNamePrefix: scenario.prefix },
        },
      },
      hasCommit: ({ refName }) => Effect.succeed(refName === `refs/heads/${scenario.collision}`),
      generateBranchName: () =>
        Deferred.succeed(namingAttempted, undefined).pipe(
          Effect.andThen(
            Effect.fail(
              new TextGenerationError({ operation: "generateBranchName", detail: "Unavailable" }),
            ),
          ),
        ),
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const launched = yield* launches.launch(
        launchInput({
          command: "prefix-launch",
          thread: "prefix-thread",
          message: "Fix the parser",
          workspace: { type: "worktree", baseRef: "main" },
        }),
      );
      const projection = yield* preparationSettled(launched.threadId);
      assert.match(projection.thread.branch!, scenario.expected);
      yield* Deferred.await(namingAttempted);
      assert.equal(projection.runs[0]?.status, "starting");
      assert.equal(harness.createWorktree.mock.calls[0]?.[0]?.newRefName, projection.thread.branch);
      assert.equal(harness.renameBranch.mock.calls.length, 0);
      assert.isFalse(projection.turnItems.some((item) => item.type === "error"));
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("fails worktree preparation when settings cannot be read", () => {
  const harness = makeHarness({
    getLaunchSettings: Effect.fail(
      new ServerSettingsError({ settingsPath: "/settings.json", operation: "read-secret" }),
    ),
  });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const launched = yield* launches.launch(
      launchInput({
        command: "settings-unreadable",
        thread: "settings-unreadable-thread",
        message: "Fix the parser",
        workspace: { type: "worktree", baseRef: "main" },
      }),
    );
    const projection = yield* preparationSettled(launched.threadId);
    assert.equal(projection.runs[0]?.status, "failed");
    assert.equal(harness.createWorktree.mock.calls.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("renames a temporary branch with a configured prefix when generation succeeds", () => {
  const harness = makeHarness({
    serverSettings: { branchNamingMode: "static", branchNamePrefix: "my-prefix" },
    generateBranchName: () => Effect.succeed({ branch: "my-prefix/fix-parser" }),
  });
  return Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const launched = yield* launches.launch(
      launchInput({
        command: "prefix-rename",
        thread: "prefix-rename-thread",
        message: "Fix the parser",
        workspace: { type: "worktree", baseRef: "main" },
      }),
    );
    yield* threads.streamStoredEventsFrom({ threadId: launched.threadId }).pipe(
      Stream.filter((stored) => stored.commandId === "prefix-rename:branch-rename"),
      Stream.runHead,
    );
    const projection = yield* threads.getThreadProjection(launched.threadId);
    assert.equal(projection.thread.branch, "my-prefix/fix-parser");
    assert.match(
      harness.renameBranch.mock.calls[0]?.[0]?.oldBranch ?? "",
      /^my-prefix\/[0-9a-f]{8}$/,
    );
  }).pipe(Effect.provide(harness.layer));
});
