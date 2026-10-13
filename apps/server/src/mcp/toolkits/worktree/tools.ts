import {
  WorktreeMcpFailure,
  OrchestratorMcpFailure,
  VcsListRefsInput,
  VcsListRefsResult,
  WorktreeMcpHandoffInput,
  WorktreeMcpHandoffResult,
  WorktreeMcpStatusResult,
  WorktreeMcpCleanupInput,
  WorktreeMcpCleanupResult,
  WorktreeMcpInventoryInput,
  WorktreeMcpInventoryResult,
  WorktreeMcpRemoveInput,
  WorktreeMcpRemoveResult,
  ThreadId,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as HostThreadsMcpService from "../../HostThreadsMcpService.ts";
import * as WorktreeInventoryService from "../../WorktreeInventoryService.ts";
import * as WorktreeMcpService from "../../WorktreeMcpService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  WorktreeMcpService.WorktreeMcpService,
];

/** What handoff and status fail with, including the access gate's refusal. */
const WorktreeToolFailure = Schema.Union([WorktreeMcpFailure, OrchestratorMcpFailure]);

const WorktreeHandoffTool = Tool.make("goat_worktree_handoff", {
  description:
    "Needs an agent running inside a GOAT thread. Move this agent thread into a new git worktree. To launch a separate agent already bound to a new or existing worktree, use goat_thread_launch with workspaceStrategy instead. Creates the worktree branch (optionally from origin), re-points the thread at the worktree, and by default runs the project's setup script there. Changing the workspace detaches the live provider session, so the current turn ends shortly after the handoff is recorded; call this as the last action of the turn. To keep working after the handoff, pass continuationPrompt with the remaining work: it is queued as the thread's next message and starts a new turn inside the worktree with the conversation preserved. Without it the thread stays idle until the next message. The worktree is not removed automatically when the thread is deleted. Fails if the thread is already attached to a worktree.",
  parameters: WorktreeMcpHandoffInput,
  success: WorktreeMcpHandoffResult,
  failure: WorktreeToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Hand off thread to a git worktree")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const WorktreeStatusTool = Tool.make("goat_worktree_status", {
  description:
    "Needs an agent running inside a GOAT thread. Report this agent thread's worktree binding: whether it is attached to a git worktree, the worktree path and branch, the project's main workspace root, and the server default for goat_worktree_handoff's startFromOrigin. Call this before goat_worktree_handoff to check whether a handoff is possible or has already happened.",
  // No `parameters`: Tool.make defaults to Tool.EmptyParams, which serializes
  // to a top-level `type: "object"` JSON Schema. An explicit empty
  // Schema.Struct({}) serializes to `anyOf: [object, array]`, which is not a
  // valid MCP tool input schema and makes clients reject the whole server.
  success: WorktreeMcpStatusResult,
  failure: WorktreeToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get thread worktree status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const WorktreeListTool = Tool.make("goat_worktree_list", {
  description:
    "List branch refs and their associated checkout paths for a thread's workspace (omit threadId for this thread) using the app's ref inventory. Detached worktrees without a branch are not included. Use goat_worktree_inventory for every worktree on a machine with its thread and unsaved work, goat_worktree_status for the thread binding, and goat_worktree_handoff to create a new worktree.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    query: VcsListRefsInput.fields.query,
    cursor: VcsListRefsInput.fields.cursor,
    limit: VcsListRefsInput.fields.limit,
    refKind: VcsListRefsInput.fields.refKind,
    includeMatchingRemoteRefs: VcsListRefsInput.fields.includeMatchingRemoteRefs,
  }),
  success: VcsListRefsResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    GitWorkflowService.GitWorkflowService,
  ],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ON_HOST =
  " Pass host (an SSH alias from goat_ssh_host_list) to act on that machine's GOAT environment instead; that needs a caller allowed to use this machine's SSH keys.";

const worktreeHostDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  WorktreeInventoryService.WorktreeInventoryService,
  HostThreadsMcpService.HostThreadsMcpService,
];

const WorktreeInventoryTool = Tool.make("goat_worktree_inventory", {
  description:
    "List every git worktree of this environment's project repositories (or of repo only): path, branch, the GOAT threads bound to it with their status and whether they are busy, uncommitted file count (dirtyCount), and commits on no remote as of the last fetch (aheadCount). Use it to find stale worktrees left by launched threads before goat_worktree_remove or goat_worktree_cleanup." +
    ON_HOST,
  parameters: WorktreeMcpInventoryInput,
  success: WorktreeMcpInventoryResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: worktreeHostDependencies,
})
  .annotate(Tool.Title, "List worktrees")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const WorktreeRemoveTool = Tool.make("goat_worktree_remove", {
  description:
    "Remove one git worktree, by path or by the threadId bound to it, with git worktree remove and prune. Always refuses a worktree whose thread is running, queued, or waiting on a question, a repository's main checkout, and a GOAT project's folder. Also refuses uncommitted changes and commits that no remote, other local branch, or merged pull request holds, unless force is true. Only worktrees of registered GOAT projects are accepted. The branch is kept unless deleteBranch is true, so a finished thread still bound to the path recreates its checkout if it runs again. Needs a full-access caller." +
    ON_HOST,
  parameters: WorktreeMcpRemoveInput,
  success: WorktreeMcpRemoveResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: worktreeHostDependencies,
})
  .annotate(Tool.Title, "Remove a worktree")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const WorktreeCleanupTool = Tool.make("goat_worktree_cleanup", {
  description:
    "Sweep stale git worktrees. A worktree is removed when every bound thread finished (completed, failed, interrupted, cancelled) or is archived, or no thread is bound and it sits in GOAT's worktrees folder, and it has no uncommitted changes and its commits are on a remote, on another local branch, or in a merged pull request. Branches are kept. Only registered GOAT projects are swept; repo must be an absolute path in one. Defaults to dryRun:true, which only reports; pass dryRun:false to remove, which needs a full-access caller. Returns removed and kept worktrees with a reason for each; main checkouts are left out." +
    ON_HOST,
  parameters: WorktreeMcpCleanupInput,
  success: WorktreeMcpCleanupResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: worktreeHostDependencies,
})
  .annotate(Tool.Title, "Clean up stale worktrees")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const WorktreeToolkit = Toolkit.make(
  WorktreeHandoffTool,
  WorktreeStatusTool,
  WorktreeListTool,
  WorktreeInventoryTool,
  WorktreeRemoveTool,
  WorktreeCleanupTool,
);
