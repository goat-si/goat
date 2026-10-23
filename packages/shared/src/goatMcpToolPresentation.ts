export type GoatMcpToolLogo = "t3-code";

export interface GoatMcpToolPresentation {
  readonly displayName: string;
  readonly logo: GoatMcpToolLogo;
}

export type GoatMcpToolSummaryAction =
  | "capabilities"
  | "delegate"
  | "task-status"
  | "task-cancel"
  | "schedule-run"
  | "schedule-create"
  | "schedule-list"
  | "schedule-update"
  | "schedule-delete"
  | "thread-create"
  | "thread-list"
  | "thread-read"
  | "thread-send"
  | "thread-wait"
  | "thread-watch"
  | "thread-unwatch"
  | "thread-watch-list"
  | "thread-interrupt"
  | "workflow-stop"
  | "thread-configuration"
  | "thread-configure"
  | "thread-fork"
  | "thread-merge"
  | "thread-search"
  | "thread-transfers"
  | "thread-organize"
  | "thread-update"
  | "queue-list"
  | "queue-read"
  | "queue-edit"
  | "queue-cancel"
  | "queue-reorder"
  | "queue-steer"
  | "question-list"
  | "question-read"
  | "question-respond"
  | "secret-request"
  | "worktree-handoff"
  | "worktree-list"
  | "worktree-status"
  | "worktree-inventory"
  | "worktree-remove"
  | "worktree-cleanup"
  | "project-list"
  | "project-read"
  | "repository-snapshot"
  | "project-create"
  | "project-update"
  | "project-delete"
  | "project-clone"
  | "environment-read"
  | "environment-update"
  | "host-status"
  | "provider-diagnose"
  | "ssh-host-list"
  | "ssh-browse"
  | "ssh-thread-launch"
  | "cloud-machine-list"
  | "cloud-machine-change"
  | "connection-list"
  | "connection-add"
  | "connection-remove"
  | "attachment-prepare"
  | "attachment-discard"
  | "attachment-send"
  | "link-pr"
  | "unlink-pr"
  | "list-prs"
  | "watch-pr"
  | "unwatch-pr"
  | "write-pr-guides"
  | "read-pr-guide"
  | "browser"
  | "device"
  | "html-preview"
  | "html-render"
  | "channel-message"
  | "channel-reply"
  | "channel-task-read"
  | "channel-task-report"
  | "channel-task-move"
  | "channel-bot-home-read"
  | "channel-bot-home-claim";

export interface GoatMcpToolDefinition {
  readonly displayName: string;
  readonly labels: readonly [action: string, running: string, completed: string, detail: string];
  readonly icon: "t3-code" | "browser" | "device" | "pull-request";
  readonly summaryAction: GoatMcpToolSummaryAction;
}

function tool(
  labels: GoatMcpToolDefinition["labels"],
  summaryAction: GoatMcpToolSummaryAction,
  icon: GoatMcpToolDefinition["icon"] = "t3-code",
  displayName = `${labels[0]} ${labels[3]}`,
): GoatMcpToolDefinition {
  return { displayName, labels, icon, summaryAction };
}

const GOAT_MCP_SERVER_ALIASES = new Set(["goat", "t3-code", "t3_code", "t3code"]);

const GOAT_MCP_TOOLS: Readonly<Record<string, GoatMcpToolDefinition>> = {
  link_pull_request: tool(
    ["Link", "Linking", "Linked", "a pull request"],
    "link-pr",
    "pull-request",
  ),
  unlink_pull_request: tool(
    ["Unlink", "Unlinking", "Unlinked", "a pull request"],
    "unlink-pr",
    "pull-request",
  ),
  list_thread_pull_requests: tool(
    ["Check", "Checking", "Checked", "linked pull requests"],
    "list-prs",
    "pull-request",
  ),
  watch_pull_request: tool(
    ["Watch", "Watching", "Watching", "a pull request"],
    "watch-pr",
    "pull-request",
  ),
  unwatch_pull_request: tool(
    ["Stop watching", "Unwatching", "Stopped watching", "a pull request"],
    "unwatch-pr",
    "pull-request",
  ),
  write_pull_request_guides: tool(
    ["Write", "Writing", "Started writing", "review guides"],
    "write-pr-guides",
    "pull-request",
  ),
  read_pull_request_guide: tool(
    ["Read", "Reading", "Read", "a review guide"],
    "read-pr-guide",
    "pull-request",
  ),
  orchestrator_capabilities: tool(
    ["Get", "Getting", "Got", "orchestration capabilities"],
    "capabilities",
  ),
  delegate_task: tool(["Delegate", "Delegating", "Delegated", "a child task"], "delegate"),
  task_status: tool(["Get", "Getting", "Got", "delegated task status"], "task-status"),
  goat_review_findings_record: tool(
    ["Record", "Recording", "Recorded", "review finding decisions"],
    "thread-update",
  ),
  goat_review_findings_export: tool(
    ["Export", "Exporting", "Exported", "review finding history"],
    "thread-read",
  ),
  task_cancel: tool(
    ["Cancel", "Canceling", "Requested cancellation of", "a delegated task"],
    "task-cancel",
  ),
  schedule_task: tool(
    ["Schedule", "Scheduling", "Scheduled", "a recurring task"],
    "schedule-create",
  ),
  list_scheduled_tasks: tool(["List", "Listing", "Listed", "scheduled tasks"], "schedule-list"),
  update_scheduled_task: tool(
    ["Update", "Updating", "Updated", "a scheduled task"],
    "schedule-update",
  ),
  delete_scheduled_task: tool(
    ["Delete", "Deleting", "Requested deletion of", "a scheduled task"],
    "schedule-delete",
  ),
  request_secret: tool(["Ask for", "Asking for", "Asked for", "a secret"], "secret-request"),
  create_threads: tool(["Create", "Creating", "Created", "GOAT threads"], "thread-create"),
  t3_thread_start: tool(["Start", "Starting", "Started", "a GOAT thread"], "thread-create"),
  goat_thread_list: tool(["List", "Listing", "Listed", "GOAT threads"], "thread-list"),
  goat_thread_read: tool(["Read", "Reading", "Read", "a GOAT thread"], "thread-read"),
  goat_thread_send: tool(["Send", "Sending", "Sent", "to a GOAT thread"], "thread-send"),
  goat_thread_wait: tool(["Wait", "Waiting", "Waited", "for a GOAT thread"], "thread-wait"),
  goat_thread_status: tool(
    ["Check", "Checking", "Checked", "a GOAT thread's status"],
    "thread-read",
  ),
  goat_thread_replication_set: tool(
    ["Set", "Setting", "Set", "checkpoint replication"],
    "thread-watch",
  ),
  goat_thread_checkpoint_capture: tool(
    ["Copy", "Copying", "Copied", "a thread checkpoint"],
    "thread-watch",
  ),
  goat_thread_checkpoint_reconcile: tool(
    ["Check", "Checking", "Checked", "a checkpoint recovery"],
    "thread-watch",
  ),
  goat_thread_checkpoint_restore: tool(
    ["Restore", "Restoring", "Restored", "a thread checkpoint"],
    "thread-watch",
  ),
  goat_thread_handoff_host: tool(
    ["Recover", "Recovering", "Recovered", "a watched thread"],
    "thread-watch",
  ),
  goat_thread_watch: tool(["Watch", "Watching", "Watched", "a GOAT thread"], "thread-watch"),
  goat_thread_unwatch: tool(
    ["Stop watching", "Stopping watch of", "Stopped watching", "a GOAT thread"],
    "thread-unwatch",
  ),
  goat_thread_watch_list: tool(
    ["List", "Listing", "Listed", "watched GOAT threads"],
    "thread-watch-list",
  ),
  goat_origin_report: tool(["Report", "Reporting", "Reported", "to the origin"], "thread-send"),
  goat_origin_reports_wait: tool(
    ["Wait", "Waiting", "Waited", "for origin reports"],
    "thread-wait",
  ),
  goat_workflow_stop: tool(
    ["Stop", "Stopping", "Requested a stop for", "a workflow"],
    "workflow-stop",
  ),
  goat_thread_interrupt: tool(
    ["Interrupt", "Interrupting", "Requested an interrupt of", "a GOAT thread"],
    "thread-interrupt",
  ),
  goat_thread_retry: tool(
    ["Retry", "Retrying", "Retried", "a GOAT thread's workspace preparation"],
    "thread-send",
  ),
  goat_worktree_handoff: tool(
    ["Hand off", "Handing off", "Handed off", "thread to a git worktree"],
    "worktree-handoff",
  ),
  goat_worktree_status: tool(
    ["Get", "Getting", "Got", "thread worktree status"],
    "worktree-status",
  ),
  preview_status: tool(["Get", "Getting", "Got", "preview browser status"], "browser", "browser"),
  preview_logs: tool(["Read", "Reading", "Read", "preview browser logs"], "browser", "browser"),
  preview_open: tool(
    ["Open", "Opening", "Opened", "a page in the preview browser"],
    "browser",
    "browser",
  ),
  preview_navigate: tool(
    ["Navigate", "Navigating", "Navigated", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_back: tool(
    ["Go back in", "Going back in", "Went back in", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_forward: tool(
    ["Go forward in", "Going forward in", "Went forward in", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_reload: tool(
    ["Reload", "Reloading", "Reloaded", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_dialog: tool(
    ["Respond", "Responding", "Responded", "to a preview browser dialog"],
    "browser",
    "browser",
  ),
  preview_snapshot: tool(
    ["Take a snapshot of", "Taking a snapshot of", "Took a snapshot of", "the preview page"],
    "browser",
    "browser",
    "Snapshot the preview page",
  ),
  preview_click: tool(
    ["Click", "Clicking", "Clicked", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_press: tool(
    ["Press", "Pressing", "Pressed", "a key in the preview browser"],
    "browser",
    "browser",
  ),
  preview_type: tool(["Type", "Typing", "Typed", "in the preview browser"], "browser", "browser"),
  preview_hover: tool(
    ["Hover", "Hovering", "Hovered", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_select: tool(
    ["Choose", "Choosing", "Chose", "an option in the preview browser"],
    "browser",
    "browser",
  ),
  preview_drag: tool(
    ["Drag", "Dragging", "Dragged", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_upload: tool(
    ["Upload", "Uploading", "Uploaded", "files to the preview browser"],
    "browser",
    "browser",
  ),
  preview_scroll: tool(
    ["Scroll", "Scrolling", "Scrolled", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_resize: tool(
    ["Resize", "Resizing", "Resized", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_evaluate: tool(
    ["Evaluate", "Evaluating", "Evaluated", "script in the preview browser"],
    "browser",
    "browser",
  ),
  preview_wait_for: tool(
    ["Wait", "Waiting", "Waited", "for the preview page"],
    "browser",
    "browser",
  ),
  preview_set_appearance: tool(
    ["Set", "Setting", "Set", "preview browser appearance"],
    "browser",
    "browser",
  ),
  preview_recording_start: tool(
    ["Start", "Starting", "Started", "recording the preview browser"],
    "browser",
    "browser",
  ),
  preview_recording_stop: tool(
    ["Stop", "Stopping", "Stopped", "recording the preview browser"],
    "browser",
    "browser",
  ),
  device_list: tool(["List", "Listing", "Listed", "simulators and emulators"], "device", "device"),
  device_open: tool(
    ["Open", "Opening", "Opened", "a device in the Device panel"],
    "device",
    "device",
  ),
  device_screenshot: tool(
    ["Take a screenshot of", "Taking a screenshot of", "Took a screenshot of", "the device"],
    "device",
    "device",
  ),
  device_close: tool(["Close", "Closing", "Closed", "a device"], "device", "device"),
  run_scheduled_task_now: tool(
    ["Run", "Running", "Requested a run of", "a scheduled task"],
    "schedule-run",
  ),
  goat_queue_list: tool(["List", "Listing", "Listed", "queued messages"], "queue-list"),
  goat_queue_read: tool(["Read", "Reading", "Read", "a queued message"], "queue-read"),
  goat_queue_edit: tool(["Edit", "Editing", "Edited", "a queued message"], "queue-edit"),
  goat_queue_cancel: tool(
    ["Cancel", "Canceling", "Requested cancellation of", "a queued run"],
    "queue-cancel",
  ),
  goat_queue_reorder: tool(["Reorder", "Reordering", "Reordered", "a queued run"], "queue-reorder"),
  goat_queue_promote_to_steer: tool(
    ["Steer with", "Steering with", "Requested steering with", "a queued message"],
    "queue-steer",
  ),
  goat_pending_request_list: tool(
    ["List", "Listing", "Listed", "pending questions"],
    "question-list",
  ),
  goat_pending_request_read: tool(["Read", "Reading", "Read", "questions"], "question-read"),
  goat_pending_request_respond: tool(
    ["Answer", "Answering", "Answered", "pending questions"],
    "question-respond",
  ),
  goat_thread_configuration: tool(
    ["Read", "Reading", "Read", "thread configuration"],
    "thread-configuration",
  ),
  goat_thread_configure: tool(["Set", "Setting", "Set", "thread model"], "thread-configure"),
  goat_thread_fork: tool(["Fork", "Forking", "Requested a fork of", "this thread"], "thread-fork"),
  goat_thread_merge_back: tool(
    ["Merge", "Merging", "Requested a merge of", "thread context"],
    "thread-merge",
  ),
  goat_thread_search: tool(["Search", "Searching", "Searched", "thread content"], "thread-search"),
  goat_thread_transfers: tool(["Read", "Reading", "Read", "thread transfers"], "thread-transfers"),
  goat_thread_organize: tool(
    ["Organize", "Organizing", "Organized", "a thread"],
    "thread-organize",
  ),
  goat_thread_report_result: tool(
    ["Report", "Reporting", "Reported", "this thread's result"],
    "thread-update",
  ),
  goat_thread_update: tool(
    ["Update", "Updating", "Updated", "GOAT thread metadata"],
    "thread-update",
  ),
  goat_worktree_list: tool(["List", "Listing", "Listed", "workspace branches"], "worktree-list"),
  goat_worktree_inventory: tool(["List", "Listing", "Listed", "worktrees"], "worktree-inventory"),
  goat_worktree_remove: tool(["Remove", "Removing", "Removed", "a worktree"], "worktree-remove"),
  goat_worktree_cleanup: tool(
    ["Clean up", "Cleaning up", "Cleaned up", "stale worktrees"],
    "worktree-cleanup",
  ),
  goat_preview_list: tool(["List", "Listing", "Listed", "preview tabs"], "browser", "browser"),
  goat_preview_close: tool(["Close", "Closing", "Closed", "a preview tab"], "browser", "browser"),
  goat_environment_read: tool(
    ["Read", "Reading", "Read", "environment preferences"],
    "environment-read",
  ),
  goat_environment_preferences_update: tool(
    ["Update", "Updating", "Updated", "environment preferences"],
    "environment-update",
  ),
  goat_host_status: tool(["Read", "Reading", "Read", "host status"], "host-status"),
  goat_hub_device_verify: tool(["Verify", "Verifying", "Verified", "device parity"], "host-status"),
  goat_hub_device_join: tool(
    ["Join", "Joining", "Joined", "a device to the hub"],
    "environment-update",
  ),
  goat_hub_device_leave: tool(
    ["Remove", "Removing", "Removed", "a device from the hub"],
    "environment-update",
  ),
  goat_hub_device_repair: tool(
    ["Repair", "Repairing", "Repaired", "a hub device"],
    "environment-update",
  ),
  goat_scheduler_status: tool(["Read", "Reading", "Read", "scheduler status"], "host-status"),
  goat_fallback_chain_get: tool(["Read", "Reading", "Read", "fallback chains"], "environment-read"),
  goat_fallback_chain_set: tool(
    ["Set", "Setting", "Set", "a fallback chain"],
    "environment-update",
  ),
  goat_goal_apply: tool(["Apply", "Applying", "Applied", "a fleet goal"], "environment-update"),
  goat_permission_profile_get: tool(
    ["Read", "Reading", "Read", "a permission profile"],
    "environment-read",
  ),
  goat_describe: tool(["Describe", "Describing", "Described", "GOAT capabilities"], "capabilities"),
  goat_call: tool(["Call", "Calling", "Called", "a GOAT capability"], "environment-update"),
  goat_operation_read: tool(["Read", "Reading", "Read", "an operation"], "host-status"),
  goat_operation_wait: tool(
    ["Wait for", "Waiting for", "Waited for", "an operation"],
    "host-status",
  ),
  goat_operation_cancel: tool(
    ["Cancel", "Cancelling", "Cancelled", "an operation"],
    "environment-update",
  ),
  goat_goatclaw_sync: tool(["Sync", "Syncing", "Synced", "goatclaw policy"], "environment-update"),
  goat_goal_get: tool(["Read", "Reading", "Read", "a fleet goal"], "host-status"),
  goat_goal_list: tool(["List", "Listing", "Listed", "fleet goals"], "host-status"),
  goat_goal_delete: tool(["Delete", "Deleting", "Deleted", "a fleet goal"], "environment-update"),
  goat_goal_pause: tool(["Pause", "Pausing", "Paused", "a fleet goal"], "environment-update"),
  goat_goal_resume: tool(["Resume", "Resuming", "Resumed", "a fleet goal"], "environment-update"),
  goat_host_cordon: tool(["Cordon", "Cordoning", "Cordoned", "a host"], "environment-update"),
  goat_host_uncordon: tool(
    ["Uncordon", "Uncordoning", "Uncordoned", "a host"],
    "environment-update",
  ),
  goat_host_drain: tool(["Drain", "Draining", "Drained", "a host"], "environment-update"),
  goat_thread_reschedule: tool(
    ["Reschedule", "Rescheduling", "Rescheduled", "a thread"],
    "thread-update",
  ),
  goat_provider_home_request: tool(
    ["Request", "Requesting", "Requested", "Codex Home approval"],
    "provider-diagnose",
  ),
  goat_computer_use_request: tool(
    ["Request", "Requesting", "Requested", "computer use approval"],
    "environment-update",
  ),
  goat_provider_diagnose: tool(
    ["Diagnose", "Diagnosing", "Diagnosed", "a provider"],
    "provider-diagnose",
  ),
  goat_provider_host_matrix: tool(
    ["Read", "Reading", "Read", "providers on each machine"],
    "provider-diagnose",
  ),
  goat_provider_sync: tool(
    ["Sync", "Syncing", "Synced", "a provider to other machines"],
    "provider-diagnose",
  ),
  goat_provider_sync_status: tool(
    ["Check", "Checking", "Checked", "provider sync progress"],
    "provider-diagnose",
  ),
  goat_provider_sync_cancel: tool(
    ["Stop", "Stopping", "Stopped", "a provider sync"],
    "provider-diagnose",
  ),
  goat_provider_addable_list: tool(
    ["List", "Listing", "Listed", "addable providers"],
    "provider-diagnose",
  ),
  goat_provider_setup_open: tool(
    ["Request", "Requesting", "Requested", "provider setup"],
    "provider-diagnose",
  ),
  goat_provider_login_start: tool(
    ["Start", "Starting", "Started", "a provider sign-in"],
    "provider-diagnose",
  ),
  goat_provider_login_status: tool(
    ["Check", "Checking", "Checked", "a provider sign-in"],
    "provider-diagnose",
  ),
  goat_provider_login_cancel: tool(
    ["Cancel", "Cancelling", "Cancelled", "a provider sign-in"],
    "provider-diagnose",
  ),
  goat_provider_update: tool(["Update", "Updating", "Updated", "a provider"], "provider-diagnose"),
  goat_provider_add: tool(["Add", "Adding", "Added", "a provider"], "provider-diagnose"),
  goat_provider_link: tool(
    ["Link", "Linking", "Linked", "a cloud provider's login"],
    "provider-diagnose",
  ),
  goat_provider_remove: tool(["Remove", "Removing", "Removed", "a provider"], "provider-diagnose"),
  goat_thread_launch: tool(
    ["Launch", "Launching", "Launched", "a project thread"],
    "thread-create",
  ),
  goat_ssh_host_add: tool(["Add", "Adding", "Added", "an SSH device"], "connection-add"),
  goat_ssh_host_prepare: tool(
    ["Prepare", "Preparing", "Prepared", "an SSH host"],
    "environment-update",
  ),
  goat_ssh_host_forget: tool(["Forget", "Forgetting", "Forgot", "an SSH host"], "ssh-host-list"),
  goat_ssh_host_list: tool(["List", "Listing", "Listed", "SSH hosts"], "ssh-host-list"),
  goat_host_link_create: tool(["Link", "Linking", "Linked", "a GOAT host"], "ssh-host-list"),
  goat_host_link_list: tool(["List", "Listing", "Listed", "linked GOAT hosts"], "ssh-host-list"),
  goat_host_link_remove: tool(
    ["Remove", "Removing", "Removed", "a linked GOAT host"],
    "ssh-host-list",
  ),
  goat_ssh_host_status: tool(
    ["Check", "Checking", "Checked", "an SSH host's runtime"],
    "host-status",
  ),
  goat_ssh_runtime_update: tool(
    ["Update", "Updating", "Updated", "an SSH host's runtime"],
    "environment-update",
  ),
  goat_ssh_browse: tool(["Browse", "Browsing", "Browsed", "folders over SSH"], "ssh-browse"),
  goat_ssh_reports: tool(["List", "Listing", "Listed", "remote thread reports"], "thread-list"),
  goat_ssh_thread_launch: tool(
    ["Start", "Starting", "Started", "a thread on another machine"],
    "ssh-thread-launch",
  ),
  // A handoff starts the continuing thread on the other machine, so it shares that summary.
  goat_ssh_thread_handoff: tool(
    ["Continue", "Continuing", "Continued", "a thread on another machine"],
    "ssh-thread-launch",
  ),
  goat_cloud_machine_list: tool(
    ["List", "Listing", "Listed", "cloud machines"],
    "cloud-machine-list",
  ),
  goat_cloud_machine_create: tool(
    ["Create", "Creating", "Created", "a cloud machine"],
    "cloud-machine-change",
  ),
  goat_cloud_machine_stop: tool(
    ["Stop", "Stopping", "Stopped", "a cloud machine"],
    "cloud-machine-change",
  ),
  goat_cloud_machine_resume: tool(
    ["Resume", "Resuming", "Resumed", "a cloud machine"],
    "cloud-machine-change",
  ),
  goat_cloud_holders: tool(
    ["List", "Listing", "Listed", "cloud credential holders"],
    "provider-diagnose",
  ),
  goat_cloud_launch: tool(["Launch", "Launching", "Launched", "a cloud agent"], "thread-create"),
  goat_cloud_run_register: tool(
    ["Register", "Registering", "Registered", "a cloud run"],
    "thread-create",
  ),
  goat_cloud_run_list: tool(["List", "Listing", "Listed", "cloud runs"], "thread-list"),
  goat_cloud_run_forget: tool(["Forget", "Forgetting", "Forgot", "a cloud run"], "thread-update"),
  goat_connection_list: tool(["List", "Listing", "Listed", "saved connections"], "connection-list"),
  goat_connection_add_ssh: tool(["Add", "Adding", "Added", "an SSH device"], "connection-add"),
  goat_connection_remove: tool(
    ["Remove", "Removing", "Removed", "a saved connection"],
    "connection-remove",
  ),
  goat_project_list: tool(["List", "Listing", "Listed", "projects"], "project-list"),
  goat_project_read: tool(["Read", "Reading", "Read", "a project"], "project-read"),
  goat_repository_snapshot: tool(
    ["Read", "Reading", "Read", "a repository snapshot"],
    "repository-snapshot",
  ),
  goat_project_create: tool(
    ["Register", "Registering", "Registered", "a project"],
    "project-create",
  ),
  goat_project_update: tool(["Update", "Updating", "Updated", "a project"], "project-update"),
  goat_project_delete: tool(["Delete", "Deleting", "Deleted", "a project"], "project-delete"),
  goat_project_clone: tool(["Clone", "Cloning", "Cloned", "a repository"], "project-clone"),
  goat_attachment_prepare_upload: tool(
    ["Prepare", "Preparing", "Prepared", "an attachment upload"],
    "attachment-prepare",
  ),
  goat_attachment_discard: tool(
    ["Discard", "Discarding", "Discarded", "a pending attachment"],
    "attachment-discard",
  ),
  goat_thread_send_attachments: tool(["Send", "Sending", "Sent", "attachments"], "attachment-send"),
  html_preview: tool(["Preview", "Previewing", "Previewed", "an HTML page"], "html-preview"),
  html_render: tool(["Render", "Rendering", "Rendered", "an HTML page"], "html-render"),
  channel_ingest: tool(
    ["Message", "Messaging", "Messaged", "GOAT's front desk"],
    "channel-message",
  ),
  channel_input_get: tool(["Read", "Reading", "Read", "a front desk reply"], "channel-reply"),
  channel_task_get: tool(["Read", "Reading", "Read", "a GOAT ledger task"], "channel-task-read"),
  channel_task_list: tool(["List", "Listing", "Listed", "GOAT ledger tasks"], "channel-task-read"),
  channel_task_export: tool(
    ["Export", "Exporting", "Exported", "GOAT ledger tasks"],
    "channel-task-read",
  ),
  channel_task_move: tool(
    ["Continue", "Continuing", "Continued", "a GOAT task on another machine"],
    "channel-task-move",
  ),
  channel_task_report: tool(
    ["Report on", "Reporting on", "Reported on", "a GOAT ledger task"],
    "channel-task-report",
  ),
  channel_bot_home: tool(
    ["Check", "Checking", "Checked", "where GOAT Bot lives"],
    "channel-bot-home-read",
  ),
  channel_bot_home_claim: tool(
    ["Move", "Moving", "Moved", "GOAT Bot to this machine"],
    "channel-bot-home-claim",
  ),
};

/**
 * The T3 orchestration tool inventory, used to gate loose name matching on
 * both the server (ACP MCP identity recovery) and the client (logo branding).
 */
// Read-side only: persisted activity can retain names from before the GOAT rename.
// Never use this alias table to register or dispatch a live MCP call.
const GOAT_MCP_LEGACY_TOOL_ALIASES: Readonly<Record<string, string>> = {
  t3_attachment_discard: "goat_attachment_discard",
  t3_attachment_prepare_upload: "goat_attachment_prepare_upload",
  t3_environment_preferences_update: "goat_environment_preferences_update",
  t3_environment_read: "goat_environment_read",
  t3_pending_request_list: "goat_pending_request_list",
  t3_pending_request_read: "goat_pending_request_read",
  t3_pending_request_respond: "goat_pending_request_respond",
  t3_preview_close: "goat_preview_close",
  t3_preview_list: "goat_preview_list",
  t3_project_clone: "goat_project_clone",
  t3_project_create: "goat_project_create",
  t3_project_delete: "goat_project_delete",
  t3_project_list: "goat_project_list",
  t3_project_read: "goat_project_read",
  t3_project_update: "goat_project_update",
  t3_queue_cancel: "goat_queue_cancel",
  t3_queue_edit: "goat_queue_edit",
  t3_queue_list: "goat_queue_list",
  t3_queue_promote_to_steer: "goat_queue_promote_to_steer",
  t3_queue_read: "goat_queue_read",
  t3_queue_reorder: "goat_queue_reorder",
  t3_ssh_browse: "goat_ssh_browse",
  t3_ssh_host_list: "goat_ssh_host_list",
  t3_ssh_thread_launch: "goat_ssh_thread_launch",
  t3_thread_configuration: "goat_thread_configuration",
  t3_thread_configure: "goat_thread_configure",
  t3_thread_fork: "goat_thread_fork",
  t3_thread_interrupt: "goat_thread_interrupt",
  t3_workflow_stop: "goat_workflow_stop",
  t3_thread_launch: "goat_thread_launch",
  t3_thread_list: "goat_thread_list",
  t3_thread_merge_back: "goat_thread_merge_back",
  t3_thread_organize: "goat_thread_organize",
  t3_thread_read: "goat_thread_read",
  t3_thread_search: "goat_thread_search",
  t3_thread_send: "goat_thread_send",
  t3_thread_send_attachments: "goat_thread_send_attachments",
  t3_thread_transfers: "goat_thread_transfers",
  t3_thread_update: "goat_thread_update",
  t3_thread_wait: "goat_thread_wait",
  t3_worktree_handoff: "goat_worktree_handoff",
  t3_worktree_list: "goat_worktree_list",
  t3_worktree_status: "goat_worktree_status",
};

export const GOAT_MCP_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(GOAT_MCP_TOOLS),
  ...Object.keys(GOAT_MCP_LEGACY_TOOL_ALIASES),
]);

function normalizeGoatMcpToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

/**
 * ACP agents disagree on how the injected T3 server prefixes its tools:
 * `mcp__goat__x` (Claude/Cursor), `goat.x` (Codex), plus single
 * underscore, colon, slash, dash, and space separators seen from registry
 * agents. The prefix match is deliberately loose because the display-name
 * inventory is the real gate; unknown tools stay on the generic renderer.
 */
function resolveGoatMcpToolName(value: string): string | null {
  const label = normalizeGoatMcpToolLabel(value);
  // Bare goat_* ids are tools themselves, before goat_ is read as a namespace.
  if (GOAT_MCP_TOOL_NAMES.has(label)) return label;
  const mcpMatch = /^mcp__(?<server>.+?)__(?<tool>.+)$/i.exec(label);
  if (mcpMatch?.groups) {
    const { server, tool } = mcpMatch.groups;
    return server !== undefined &&
      tool !== undefined &&
      GOAT_MCP_SERVER_ALIASES.has(server.toLowerCase())
      ? tool
      : null;
  }

  const namespaceMatch =
    /^(?<server>goat|t3-code|t3_code|t3code)(?:[.:/]|\s*·\s*)(?<tool>.+)$/i.exec(label);
  if (namespaceMatch?.groups) {
    return namespaceMatch.groups.tool ?? null;
  }

  const prefixed = /^(?:mcp[-_]{1,2})?(?:goat|t3[-_ ]?code)(?:__|[-_.:/ ])(?<tool>.+)$/i.exec(
    label,
  );
  const candidate = prefixed?.groups?.tool ?? label;
  if (GOAT_MCP_TOOL_NAMES.has(candidate)) return candidate;
  // OpenCode 2 registers `goat-<thread>`; persisted `t3-code-<thread>` names
  // remain readable. Each server joins
  // it to the tool with `_`. Thread ids can hold `_` too, so take the longest
  // known tool name that ends the label.
  if (!/^(?:goat|t3-code)-/i.test(label)) return null;
  let longest: string | null = null;
  for (const tool of GOAT_MCP_TOOL_NAMES) {
    if (label.endsWith(`_${tool}`) && tool.length > (longest?.length ?? 0)) longest = tool;
  }
  return longest;
}

export function resolveGoatMcpToolId(toolName: string | null | undefined): string | null {
  const name = toolName == null ? null : resolveGoatMcpToolName(toolName);
  return name !== null && GOAT_MCP_TOOL_NAMES.has(name) ? name : null;
}

export function resolveGoatMcpToolDefinition(
  toolName: string | null | undefined,
): GoatMcpToolDefinition | null {
  const name = toolName == null ? null : resolveGoatMcpToolName(toolName);
  const canonicalName = name === null ? null : (GOAT_MCP_LEGACY_TOOL_ALIASES[name] ?? name);
  return canonicalName !== null && Object.hasOwn(GOAT_MCP_TOOLS, canonicalName)
    ? GOAT_MCP_TOOLS[canonicalName]!
    : null;
}

export function resolveGoatMcpToolPresentation(
  toolName: string | null | undefined,
): GoatMcpToolPresentation | null {
  const definition = resolveGoatMcpToolDefinition(toolName);
  return definition === null ? null : { displayName: definition.displayName, logo: "t3-code" };
}
