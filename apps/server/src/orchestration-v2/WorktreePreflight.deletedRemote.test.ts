import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import { makeHarness } from "./testkit/ThreadLaunchHarness.ts";
import { projectId } from "./testkit/threadLaunchInput.ts";

// A remote can delete the branch a ref names after it was fetched; its name alone proves nothing.
it.effect("refuses a new worktree whose base ref was deleted on its remote", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      hasCommit: ({ refName }) => Effect.succeed(refName === "HEAD"),
      fetchWorktreeBaseCommit: () => Effect.succeed(null),
      git: {
        resolveWorktreeBaseRemote: () =>
          Effect.succeed({ remoteName: "origin", branchName: "development" }),
        hasRefNamed: () => Effect.succeed(false),
      },
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const error = yield* launches
        .checkWorktreeBase({
          projectId,
          workspaceStrategy: {
            type: "worktree",
            baseRef: "origin/development",
            startFromOrigin: true,
          },
        })
        .pipe(Effect.flip);
      assert.deepInclude(error, {
        _tag: "ThreadLaunchBaseRefError",
        projectId,
        baseRef: "origin/development",
      });
    }).pipe(Effect.provide(harness.layer));
  }),
);
