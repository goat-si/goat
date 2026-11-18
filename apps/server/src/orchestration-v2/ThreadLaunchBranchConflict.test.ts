import { assert, it } from "@effect/vitest";
import { CommandId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { makeHarness } from "./testkit/ThreadLaunchHarness.ts";
import { launchInput, projectId } from "./testkit/threadLaunchInput.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";

it.effect.each([
  { requested: "werkstatt/baseline", blocking: "werkstatt" },
  { requested: "foo", blocking: "foo/bar" },
])("refuses a new worktree branch $requested that collides with branch $blocking", (testCase) =>
  Effect.gen(function* () {
    const harness = makeHarness({
      hasCommit: () => Effect.succeed(true),
      git: { listLocalBranchNames: () => Effect.succeed(["main", "werkstatt", "foo/bar"]) },
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const workspace = { type: "worktree" as const, baseRef: "main", branch: testCase.requested };
      const commandId = CommandId.make("launch:branch-conflict");
      const check = (branch: string) =>
        launches.checkWorktreeBase({
          commandId,
          projectId,
          workspaceStrategy: { ...workspace, branch },
        });
      yield* check("werkstatt-baseline");
      const error = yield* check(testCase.requested).pipe(Effect.flip);
      assert.deepInclude(error, {
        _tag: "ThreadLaunchBranchConflictError",
        branch: testCase.requested,
        conflictingBranch: testCase.blocking,
      });
      yield* launches.launch(
        launchInput({ command: commandId, thread: "thread:branch-conflict", workspace }),
      );
      yield* check(testCase.requested);
    }).pipe(Effect.provide(harness.layer));
  }),
);
