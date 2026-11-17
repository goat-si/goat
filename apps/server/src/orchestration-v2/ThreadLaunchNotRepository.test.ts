import { assert, it } from "@effect/vitest";
import { GitCommandError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { makeHarness, project } from "./testkit/ThreadLaunchHarness.ts";
import { projectId } from "./testkit/threadLaunchInput.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";

const worktree = { type: "worktree" as const, baseRef: "main" };

it.effect.each([
  {
    name: "is not a Git repository",
    repositoryRoot: () => Effect.succeed(null),
    message: `Project "${project.title}" (${project.workspaceRoot}) is not a Git repository.`,
  },
  {
    name: "could not be checked for a Git repository",
    repositoryRoot: () =>
      Effect.fail(
        new GitCommandError({
          operation: "GitWorkflowService.repositoryRoot",
          command: "git rev-parse --show-toplevel",
          cwd: project.workspaceRoot,
          detail: "timed out",
        }),
      ),
    message: `GOAT could not check whether project "${project.title}" (${project.workspaceRoot}) is a Git repository (`,
  },
])("refuses a new worktree in a project that $name, creating nothing", (testCase) =>
  Effect.gen(function* () {
    const harness = makeHarness({
      hasCommit: () => Effect.succeed(true),
      git: { repositoryRoot: testCase.repositoryRoot },
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const error = yield* launches
        .checkWorktreeBase({ projectId, workspaceStrategy: worktree })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ThreadLaunchNotRepositoryError");
      assert.isTrue(error.message.startsWith(testCase.message), error.message);
      assert.equal(harness.createWorktree.mock.calls.length, 0);
      // A launch that needs no new checkout is not asked.
      yield* launches.checkWorktreeBase({ projectId, workspaceStrategy: { type: "root" } });
    }).pipe(Effect.provide(harness.layer));
  }),
);

// The preflight asks only whether Git finds a repository, so a project in a subfolder of one passes.
it.effect("lets a new worktree through for a project inside a repository", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      hasCommit: () => Effect.succeed(true),
      git: { repositoryRoot: () => Effect.succeed("/repository-above-the-project") },
    });
    yield* ThreadLaunch.ThreadLaunchService.pipe(
      Effect.flatMap((launches) =>
        launches.checkWorktreeBase({ projectId, workspaceStrategy: worktree }),
      ),
      Effect.provide(harness.layer),
    );
  }),
);
