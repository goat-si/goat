import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrchestrationV2ShellThreadStatus } from "./orchestrationV2.ts";
import { OrchestratorMcpHost } from "./orchestratorMcp.ts";

/**
 * The server picks the location in its managed worktrees folder.
 * Changing the thread's workspace detaches the live provider session, so the
 * current turn ends shortly after the handoff is recorded; the conversation
 * continues inside the worktree on the thread's next run.
 */
export const WorktreeMcpHandoffInput = Schema.Struct({
  branch: TrimmedNonEmptyString.annotate({
    description: "Branch name to create for the worktree (e.g. 'feature/my-change').",
  }),
  baseRef: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Branch or ref the worktree branch starts from. Defaults to the branch currently checked out in the project workspace.",
    }),
  ),
  startFromOrigin: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Fetch the remote baseRef belongs to and start the worktree branch from its remote-tracking commit instead of the local ref. Defaults to the server's 'new worktrees start from remote' setting.",
    }),
  ),
  runSetupScript: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Run the project's configured setup script in the new worktree after handoff. Defaults to true.",
    }),
  ),
  continuationPrompt: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)).annotate({
      description:
        "Message queued as the thread's next turn after the handoff. The handoff detaches the current provider session, so pass the remaining work here to automatically resume inside the worktree; omit it to stop after the handoff and wait for the next message.",
    }),
  ),
});
export type WorktreeMcpHandoffInput = typeof WorktreeMcpHandoffInput.Type;

export const WorktreeMcpSetupScriptStatus = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("started"),
    scriptName: TrimmedNonEmptyString,
    terminalId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    status: Schema.Literal("no-script"),
  }),
  Schema.Struct({
    status: Schema.Literal("skipped"),
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    detail: Schema.String,
  }),
]);
export type WorktreeMcpSetupScriptStatus = typeof WorktreeMcpSetupScriptStatus.Type;

export const WorktreeMcpContinuationStatus = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("scheduled"),
    delivery: Schema.Literals(["started", "queued", "steered", "restarted"]),
  }),
  Schema.Struct({
    status: Schema.Literal("skipped"),
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    detail: Schema.String,
  }),
]);
export type WorktreeMcpContinuationStatus = typeof WorktreeMcpContinuationStatus.Type;

export const WorktreeMcpHandoffResult = Schema.Struct({
  worktreePath: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  baseRef: TrimmedNonEmptyString,
  startedFromOrigin: Schema.Boolean,
  setupScript: WorktreeMcpSetupScriptStatus,
  continuation: WorktreeMcpContinuationStatus,
  note: Schema.String,
});
export type WorktreeMcpHandoffResult = typeof WorktreeMcpHandoffResult.Type;

export const WorktreeMcpStatusResult = Schema.Struct({
  attached: Schema.Boolean.annotate({
    description: "True when this thread is already attached to a git worktree.",
  }),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  projectWorkspaceRoot: TrimmedNonEmptyString.annotate({
    description: "Root of the project's main workspace checkout.",
  }),
  defaultStartFromOrigin: Schema.Boolean.annotate({
    description: "Server default used by goat_worktree_handoff when startFromOrigin is omitted.",
  }),
});
export type WorktreeMcpStatusResult = typeof WorktreeMcpStatusResult.Type;

export class WorktreeMcpFailure extends Schema.TaggedError<WorktreeMcpFailure>()(
  "WorktreeMcpFailure",
  {
    code: Schema.Literals([
      "capability_denied",
      "thread_not_found",
      "project_not_found",
      "already_in_worktree",
      "handoff_in_progress",
      "invalid_request",
      "operation_failed",
      "thread_credential_required",
    ]),
    message: Schema.String,
  },
) {}

const resultHost = Schema.optional(Schema.String).annotate({
  description: "The SSH host this came from; absent for this environment.",
});

const RepositoryPath = TrimmedNonEmptyString.annotate({
  description:
    "Any checkout of one repository (its main checkout or one of its worktrees). Omit for every project repository in this environment.",
});

export const WorktreeMcpBoundThread = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  status: OrchestrationV2ShellThreadStatus,
  archived: Schema.Boolean,
  busy: Schema.Boolean.annotate({
    description:
      "True while the thread has a run, queued turn, pending question, or background work.",
  }),
});
export type WorktreeMcpBoundThread = typeof WorktreeMcpBoundThread.Type;

export const WorktreeMcpInventoryEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString.annotate({
    description: "The repository's main checkout.",
  }),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  main: Schema.Boolean.annotate({ description: "True for the repository's main checkout." }),
  missing: Schema.Boolean.annotate({
    description: "True when git still lists the worktree but its folder is gone.",
  }),
  managed: Schema.Boolean.annotate({
    description: "True when the worktree sits in GOAT's worktrees folder.",
  }),
  threads: Schema.Array(WorktreeMcpBoundThread),
  dirtyCount: Schema.NullOr(NonNegativeInt).annotate({
    description: "Uncommitted tracked and untracked files; null when the folder could not be read.",
  }),
  aheadCount: Schema.NullOr(NonNegativeInt).annotate({
    description:
      "Commits on HEAD that are on no remote-tracking branch, as of the last fetch; null when unreadable.",
  }),
});
export type WorktreeMcpInventoryEntry = typeof WorktreeMcpInventoryEntry.Type;

export const WorktreeMcpInventoryInput = Schema.Struct({
  host: Schema.optional(OrchestratorMcpHost),
  repo: Schema.optional(RepositoryPath),
});
export type WorktreeMcpInventoryInput = typeof WorktreeMcpInventoryInput.Type;

export const WorktreeMcpInventoryResult = Schema.Struct({
  worktrees: Schema.Array(WorktreeMcpInventoryEntry),
  host: resultHost,
});
export type WorktreeMcpInventoryResult = typeof WorktreeMcpInventoryResult.Type;

export const WorktreeMcpRemoveInput = Schema.Struct({
  host: Schema.optional(OrchestratorMcpHost),
  path: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "Absolute path of the worktree to remove, as goat_worktree_inventory lists it. A symlink to a worktree is refused.",
    }),
  ),
  threadId: Schema.optional(
    ThreadId.annotate({ description: "Remove the worktree this thread is bound to." }),
  ),
  force: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Remove even with uncommitted changes or commits on no remote. Default false. Never overrides a busy thread, a main checkout, or a project folder.",
    }),
  ),
  deleteBranch: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Also delete the worktree's local branch. Default false. Never deletes the repository's default branch, and refuses a branch whose commits no remote, other branch, or merged pull request holds unless deleteUnsavedBranch is true. A bound thread can then no longer recreate its checkout.",
    }),
  ),
  deleteUnsavedBranch: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "With deleteBranch, delete the branch even when its commits exist nowhere else, losing them. Default false. Separate from force, which only covers the checkout.",
    }),
  ),
});
export type WorktreeMcpRemoveInput = typeof WorktreeMcpRemoveInput.Type;

export const WorktreeMcpRemoveResult = Schema.Struct({
  path: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  branchDeleted: Schema.Boolean,
  notes: Schema.Array(Schema.String),
  host: resultHost,
});
export type WorktreeMcpRemoveResult = typeof WorktreeMcpRemoveResult.Type;

export const WorktreeMcpCleanupInput = Schema.Struct({
  host: Schema.optional(OrchestratorMcpHost),
  repo: Schema.optional(RepositoryPath),
  dryRun: Schema.optional(
    Schema.Boolean.annotate({
      description: "Default true: report what would be removed. Pass false to remove.",
    }),
  ),
});
export type WorktreeMcpCleanupInput = typeof WorktreeMcpCleanupInput.Type;

export const WorktreeMcpCleanupEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  reason: Schema.String,
});
export type WorktreeMcpCleanupEntry = typeof WorktreeMcpCleanupEntry.Type;

export const WorktreeMcpCleanupResult = Schema.Struct({
  dryRun: Schema.Boolean,
  removed: Schema.Array(WorktreeMcpCleanupEntry).annotate({
    description: "Removed worktrees, or with dryRun the ones that would be removed.",
  }),
  kept: Schema.Array(WorktreeMcpCleanupEntry),
  host: resultHost,
});
export type WorktreeMcpCleanupResult = typeof WorktreeMcpCleanupResult.Type;
