import { assert, it } from "@effect/vitest";
import { GitCommandError, ProjectId } from "@goat/contracts";
import * as Effect from "effect/Effect";

import type * as GitWorkflow from "../git/GitWorkflowService.ts";
import type * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import type * as ProjectService from "../project/ProjectService.ts";
import type * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { makeWorktreePreflight, ThreadLaunchNotRepositoryError } from "./WorktreePreflight.ts";

const projectId = ProjectId.make("project-plain-folder");
const project = { id: projectId, title: "Plain folder", workspaceRoot: "/work/plain" };

const preflight = (repositoryRoot: GitWorkflow.GitWorkflowService["Service"]["repositoryRoot"]) =>
  makeWorktreePreflight({
    projects: {
      getById: () => Effect.succeedSome(project),
    } as unknown as ProjectService.ProjectService["Service"],
    git: {
      repositoryRoot,
      hasCommit: () => Effect.succeed(true),
    } as unknown as GitWorkflow.GitWorkflowService["Service"],
    receipts: {
      getByCommandId: () => Effect.succeedNone,
    } as unknown as CommandReceiptStore.CommandReceiptStoreV2["Service"],
    managedFolders: {
      isScratchProject: () => Effect.succeed(false),
    } as unknown as ManagedProjectFolders.ManagedProjectFolders["Service"],
  });

const worktree = { type: "worktree", baseRef: "main" } as const;

it.effect("refuses a worktree launch in a project that is not a Git repository", () =>
  Effect.gen(function* () {
    const check = preflight(() => Effect.succeed(null));
    const error = yield* Effect.flip(check({ projectId, workspaceStrategy: worktree }));
    assert.instanceOf(error, ThreadLaunchNotRepositoryError);
    assert.equal(error.message, 'Project "Plain folder" (/work/plain) is not a Git repository.');
    // Launches that need no new checkout are not asked.
    yield* check({ projectId, workspaceStrategy: { type: "root" } });
  }),
);

// Upstream lets a failed detection through to workspace preparation; GOAT refuses it here.
it.effect("refuses a worktree launch when GOAT could not check for a Git repository", () =>
  Effect.gen(function* () {
    const check = preflight(() =>
      Effect.fail(
        new GitCommandError({
          operation: "GitWorkflowService.repositoryRoot",
          command: "git rev-parse --show-toplevel",
          cwd: project.workspaceRoot,
          detail: "Permission denied",
        }),
      ),
    );
    const error = yield* Effect.flip(check({ projectId, workspaceStrategy: worktree }));
    assert.instanceOf(error, ThreadLaunchNotRepositoryError);
    assert.match(
      error.message,
      /^GOAT could not check whether project "Plain folder" \(\/work\/plain\) is a Git repository \(.*Permission denied.*\)\.$/,
    );
  }),
);

it.effect("lets a worktree launch in a Git repository through", () =>
  preflight(() => Effect.succeed(project.workspaceRoot))({
    projectId,
    workspaceStrategy: worktree,
  }),
);
