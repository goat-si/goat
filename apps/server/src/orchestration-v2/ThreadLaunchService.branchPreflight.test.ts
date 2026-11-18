import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import { makeHarness } from "./testkit/ThreadLaunchHarness.ts";
import { projectId } from "./testkit/threadLaunchInput.ts";

const existingBranch = (
  state: Partial<GitVcsDriver.ExistingBranchState>,
): GitVcsDriver.ExistingBranchState => ({
  tip: "tip",
  baseSha: "base",
  uniqueCommits: 0,
  worktreePath: null,
  dirty: false,
  ...state,
});

it.effect.each([
  {
    name: "has commits its base lacks in another worktree",
    state: { uniqueCommits: 2, worktreePath: "/worktrees/lane" },
    message:
      'Branch "lane/fix" is already checked out at /worktrees/lane in project "Project" and has 2 commits that origin/lane/fix does not, so a new worktree cannot reuse it.',
  },
  {
    name: "has a commit its base lacks and no worktree",
    state: { uniqueCommits: 1 },
    message:
      'Branch "lane/fix" already exists in project "Project" (/repo) and has 1 commit that origin/lane/fix does not, so a new worktree cannot reuse it.',
  },
  {
    name: "has uncommitted changes in its worktree",
    state: { worktreePath: "/worktrees/lane", dirty: true },
    message:
      'Branch "lane/fix" is already checked out at /worktrees/lane in project "Project" and has uncommitted changes there, so a new worktree cannot reuse it.',
  },
  {
    name: "is the project's main checkout",
    state: { worktreePath: "/repo" },
    message:
      'Branch "lane/fix" is already checked out at /repo in project "Project" and is the project\'s main checkout, so a new worktree cannot reuse it.',
  },
])("refuses a new worktree whose branch $name", (testCase) =>
  Effect.gen(function* () {
    const harness = makeHarness({
      hasCommit: () => Effect.succeed(true),
      git: {
        inspectExistingBranch: ({ branch }) =>
          Effect.succeed(branch === "lane/fix" ? existingBranch(testCase.state) : null),
      },
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const error = yield* launches
        .checkWorktreeBase({
          projectId,
          workspaceStrategy: {
            type: "worktree",
            baseRef: "origin/lane/fix",
            branch: "lane/fix",
            startFromOrigin: true,
          },
        })
        .pipe(Effect.flip);
      assert.deepInclude(error, {
        _tag: "ThreadLaunchBranchError",
        projectId,
        branch: "lane/fix",
        worktreePath: testCase.state.worktreePath ?? null,
      });
      assert.equal(error.message, testCase.message);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect.each([
  { name: "a clean worktree", state: { worktreePath: "/worktrees/lane" } },
  { name: "no worktree", state: {} },
])("lets a launch reuse an existing branch with no commits of its own and $name", (testCase) =>
  Effect.gen(function* () {
    const harness = makeHarness({
      hasCommit: () => Effect.succeed(true),
      git: { inspectExistingBranch: () => Effect.succeed(existingBranch(testCase.state)) },
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      yield* launches.checkWorktreeBase({
        projectId,
        workspaceStrategy: { type: "worktree", baseRef: "main", branch: "lane/fix" },
      });
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("leaves a new branch name to the launch", () =>
  Effect.gen(function* () {
    const harness = makeHarness({
      hasCommit: ({ refName }) => Effect.succeed(!refName.startsWith("refs/heads/")),
      git: { inspectExistingBranch: () => Effect.succeed(null) },
    });
    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      yield* launches.checkWorktreeBase({
        projectId,
        workspaceStrategy: { type: "worktree", baseRef: "main", branch: "lane/new" },
      });
    }).pipe(Effect.provide(harness.layer));
  }),
);
