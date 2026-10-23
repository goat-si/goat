import type { AgentSurfaceEntry, CapabilityDeclaration, IdempotencyDeclaration } from "./types.ts";

/** The thread launch writes, here and over SSH, kept beside the registry like providerEntries.ts. */
export const launchSurfaceEntries = {
  thread: {
    resource: "thread",
    verb: "launch",
    name: "goat_thread_launch",
    toolkit: "project",
    summary:
      "Create an ordinary TOP-LEVEL thread with an explicit workspace binding before its agent starts.",
    description:
      'Create an ordinary TOP-LEVEL thread with an explicit workspace binding before its agent starts. Use this when the user requests independent work, a new thread, or a PR stack in its own worktree, and for work that owns a goal, runs a loop (HOTL, cxc-loop, repeated PABCD), or spans several cycles, even when the user calls it a subagent: top-level threads appear in the sidebar, where the user can open, steer, and resume them. Use delegate_task for bounded child subagents that report back and end. Set workspaceStrategy to {type:"worktree",baseRef:"parent-branch",branch:"new-branch",startFromOrigin:false} for a new worktree based on local commits, or {type:"existing_worktree",worktreePath:"/absolute/path",branch:"existing-branch"} to use an existing checkout. To fetch and start from the base branch\'s remote, set startFromOrigin:true. Omitted workspaceStrategy means the project root, NOT the caller\'s worktree. Omit projectId/modelSelection/modes to inherit those settings from the calling thread; a caller outside a GOAT thread must pass projectId and gets the project\'s default model. Set scratch:true instead of projectId for a thread without a project: it runs in a fresh folder of its own, outside any repository. Put the task in message. Do not ask the agent to create its own worktree via shell: that does not update the thread binding. Pass clientRequestId to retry safely: a repeat with the same arguments returns the first launch instead of starting another. Retain threadId. A calling GOAT thread is woken with a message when the run of the new thread ends or waits on a question, so do not poll it with goat_thread_wait; notifyOnCompletion:false or goat_thread_unwatch stops run-end and host-outage reports. Only local user-input questions still arrive. SSH-host questions then need goat_thread_wait({host}) or goat_pending_request_list({scope:"launched", hosts}). Approvals are no longer reported; check goat_thread_read or tell the user the thread may be waiting. To link a thread for the user, write `[title](goat-thread://v1/<threadId>)` with the threadId exactly as returned, not URL-encoded; GOAT shows the thread\'s current title. After errors or lost responses, inspect goat_thread_list before retrying. Attachments must be pending uploads. The new thread may not run with broader runtime or interaction modes than the caller: the calling GOAT thread\'s own modes, or the permission mode an outside agent was approved with. A cloud provider runs without creating a local worktree or running setup. Most cloud providers start from the published source branch and refuse an unavailable or unpublished source with a reason; providers that upload the project folder (such as Claude Cloud) start from its current branch, and local changes may be included. Choose a project repository; scratch is unavailable for cloud tasks. Follow-ups target the same cloud session when its capabilities permit them.',
    effect: "destructive",
    capability: "threads.launch",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: ["secret", "approval"],
    annotations: {
      idempotentHint: false,
      openWorldHint: true,
    },
    idempotency: "key",
    reconcile: "thread.list",
  },
  ssh: {
    resource: "ssh",
    verb: "thread_launch",
    name: "goat_ssh_thread_launch",
    toolkit: "ssh",
    summary: "Start a thread on another machine",
    description:
      "Start a thread on ANOTHER machine, in that machine's own GOAT environment, over SSH. Use it when the user asks to run work on a different computer. Pick host from goat_ssh_host_list and cwd from goat_ssh_browse. A linked host from goat_host_link_list works too, without SSH: it cannot be browsed, so cwd must be the absolute folder of one of its existing projects (goat_project_list with that host lists them) and a worktree needs baseRef. For coding work pass workspace {type:\"worktree\",baseRef,branch} so the thread gets its own checkout. cwd must be a project folder: the filesystem root, the home directory, a folder above home, or another top-level folder is refused unless the user explicitly asked for it and allowBroadWorkspaceRoot is true. The folder becomes (or reuses) a project on the remote, then the thread starts in the folder or in a worktree per workspace, and its agent gets message. GOAT is launched on the remote if it is not running. Omitted modelSelection uses the calling thread's model, which the remote must also offer. Needs a full-access caller. The thread lives on the remote. A calling GOAT thread is woken with a message when its run ends, waits on a question, or the host stays unreachable, so do not poll it; read it with goat_thread_read and steer it with goat_thread_send, passing the same host and the returned threadId; the user can watch it by connecting to that host in Settings → Connections. Launched from a thread, the remote thread can also report progress, results and questions with goat_origin_report; they reach this thread per reportDelivery, and goat_ssh_reports lists what arrived. Pass clientRequestId to retry safely: a repeat with the same arguments returns the first launch instead of starting another. Without one, each call creates a new thread; after a lost response, check goat_thread_list with host before retrying. Attachments must be pending uploads in this environment: up to eight references from goat_attachment_prepare_upload, after their local byte uploads finish. Their bytes are uploaded to the destination before its thread starts; already-delivered thread attachments cannot be forwarded this way.",
    effect: "destructive",
    capability: "threads.remote",
    hostRoutable: true,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: ["secret", "approval"],
    annotations: {
      title: "Start a thread on another machine",
      idempotentHint: false,
      openWorldHint: true,
    },
    idempotency: "key",
    reconcile: "thread.list",
  },
} as const satisfies Record<
  string,
  AgentSurfaceEntry & CapabilityDeclaration & IdempotencyDeclaration
>;
