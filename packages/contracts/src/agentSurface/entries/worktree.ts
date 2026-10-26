import { entry } from "../entry.ts";

export const worktreeEntries = {
  "worktree.handoff": entry({
    resource: "worktree",
    verb: "handoff",
    name: "goat_worktree_handoff",
    toolkit: "worktree",
    summary: "Hand off thread to a git worktree",
    description:
      "Move this agent thread into a new GOAT-managed worktree and branch. The provider session detaches and this turn ends: call it last, and pass continuationPrompt to queue the remaining work. Setup and the continuation can fail after the move succeeds; check their statuses. The worktree outlives the thread. For a separate thread use goat_thread_launch with workspaceStrategy type='worktree'.",
    guide:
      "Run inside a GOAT thread. The thread must not already have a worktree binding. Use goat_worktree_status first to check it.\n\nThe handoff creates a branch and worktree in GOAT's managed worktrees directory, optionally using the base branch's remote, then repoints this thread. Do not create ad-hoc worktrees or clones through the shell for lanes; shell commands do not update thread bindings. Project setup runs by default; pass runSetupScript:false to skip it.\n\nFor a separate thread, use goat_thread_launch with workspaceStrategy:{type:'worktree'} for a new worktree or type:'existing_worktree' to bind an existing one. For a bounded child lane needing its own checkout, use goat_task_create with isolation='worktree'.\n\nChanging the workspace detaches the provider session shortly after the handoff is recorded. Call this as the last action of the turn. Pass continuationPrompt with the remaining work to queue the next message and start a turn inside the worktree with the conversation preserved. Without a continuation, the thread stays idle until its next message. Check the returned continuation status for a queue failure. Deleting the thread does not automatically remove the worktree.",
    idempotencyReason:
      "WorktreeMcpService.handoff serializes per calling thread, refuses an already-bound worktree or existing branch, and rechecks binding before commit. Repeating cannot bind a second worktree or queue a second continuation.",
    effect: "destructive",
    capability: "worktree.create",
    hostRoutable: false,
    requires: "thread",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "Hand off thread to a git worktree",
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
  "worktree.status": entry({
    resource: "worktree",
    verb: "status",
    name: "goat_worktree_status",
    toolkit: "worktree",
    summary: "Get thread worktree status",
    description:
      "Read this agent thread's worktree binding, path, branch, main workspace root, and the default startFromOrigin for goat_worktree_handoff. Check it before handing off.",
    guide:
      "Run inside a GOAT thread. Call goat_worktree_status before goat_worktree_handoff to see whether the thread already has a worktree binding and whether handoff is possible.",
    effect: "read",
    hostRoutable: false,
    requires: "thread",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "Get thread worktree status",
      idempotentHint: true,
      openWorldHint: false,
    },
  }),
  "worktree.list": entry({
    resource: "worktree",
    verb: "list",
    name: "goat_worktree_list",
    toolkit: "worktree",
    summary:
      "List branch refs and their associated checkout paths for a thread's workspace (omit threadId for this thread) using the app's ref inventory.",
    description:
      "Read branch refs and associated checkout paths for a thread's workspace; omit threadId for this thread. Detached worktrees without a branch are excluded. Use goat_worktree_inventory for every worktree and its threads or unsaved work.",
    guide:
      "This uses the app's ref inventory for the thread's worktree, or its project workspace when no worktree is bound.\n\nUse goat_worktree_inventory for every worktree with its threads and unsaved work, goat_worktree_status for this thread's binding, and goat_worktree_handoff to create a worktree for this thread.",
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
  "worktree.inventory": entry({
    resource: "worktree",
    verb: "inventory",
    name: "goat_worktree_inventory",
    toolkit: "worktree",
    summary: "List worktrees",
    description:
      "Read every git worktree in registered project repositories, or just repo, with paths, branches, bound GOAT threads, busy status and dirtyCount. aheadCount counts commits missing from remote-tracking refs as of the last fetch. Use it before goat_worktree_remove or goat_worktree_cleanup. Supports host.",
    guide:
      "dirtyCount counts uncommitted files; aheadCount counts commits on no remote-tracking ref as of the last fetch. Bound threads include their status and whether they are busy. Use goat_worktree_inventory before goat_worktree_remove or goat_worktree_cleanup to find stale checkouts left by launched threads.\n\nPass host from goat_ssh_host_list or goat_host_link_list to use that machine's GOAT environment. Host calls require a live caller permitted to reach other machines with this machine's credentials.",
    effect: "read",
    hostRoutable: true,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "List worktrees",
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
  "worktree.remove": entry({
    resource: "worktree",
    verb: "remove",
    name: "goat_worktree_remove",
    toolkit: "worktree",
    summary: "Remove a worktree",
    description:
      "Remove a registered project's git worktree by path or bound threadId, then prune. deleteBranch:true is attempted after removal; check branchDeleted and notes. Threads keep their binding and may recreate a managed checkout when run again. force:true bypasses uncommitted or unpreserved work checks.",
    guide:
      "Pass exactly one of path or bound threadId. Only worktrees in registered GOAT project repositories are accepted.\n\nThe tool always refuses a busy worktree: a running or queued thread, pending question, or background work blocks removal. It also always refuses the repository's main checkout and a worktree that is or contains a GOAT project folder. Without force:true, it refuses uncommitted changes or commits held by no remote, other local branch, or merged pull request.\n\nBranches stay unless deleteBranch:true. A finished thread keeps its binding; a later local run can recreate a missing managed checkout if its branch survives. Automatic recreation does not cover arbitrary worktree paths.\n\nUse a full-access/default caller. Pass host from goat_ssh_host_list or goat_host_link_list to use that machine's GOAT environment. Host calls require a live caller permitted to reach other machines with this machine's credentials.",
    effect: "destructive",
    capability: "worktree.create",
    hostRoutable: true,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "Remove a worktree",
      idempotentHint: false,
      openWorldHint: true,
    },
    idempotency: "key",
    reconcile: "worktree.inventory",
  }),
  "worktree.cleanup": entry({
    resource: "worktree",
    verb: "cleanup",
    name: "goat_worktree_cleanup",
    toolkit: "worktree",
    summary: "Clean up stale worktrees",
    description:
      "Sweep stale git worktrees of registered projects, keeping branches. Default dryRun:true only reports; pass dryRun:false to remove. A sweep keeps busy worktrees, unsaved changes, and unpreserved commits. Unbound worktrees qualify only inside GOAT's worktrees folder. Supports host.",
    guide:
      "A bound worktree qualifies when every thread has finished (completed, failed, interrupted, or cancelled) or is archived, and none is busy. An unbound worktree qualifies only in GOAT's worktrees folder. It must have no uncommitted changes, and its commits must be held by remote refs, another local branch, or a merged pull request. Branches stay.\n\nOnly registered GOAT project repositories are swept. If supplied, repo must be an absolute path within one. dryRun defaults to true and only reports; dryRun:false removes eligible worktrees and needs a full-access/default caller. Returns removed and kept entries with reasons; during a dry run, removed means candidates for removal. Main checkouts are left out.\n\nPass host from goat_ssh_host_list or goat_host_link_list to use that machine's GOAT environment. Host calls require a live caller permitted to reach other machines with this machine's credentials.",
    idempotencyReason:
      "WorktreeInventoryService.cleanup rescans current worktrees, skips protected/busy/unsaved ones and removes only eligible entries. Removed entries disappear; kept failures must be rechecked on a later sweep, not replayed.",
    effect: "destructive",
    capability: "worktree.create",
    hostRoutable: true,
    requires: "either",
    dryRun: "supported",
    humanSteps: [],
    annotations: {
      title: "Clean up stale worktrees",
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
} as const;
