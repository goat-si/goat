import { entry } from "../entry.ts";

export const taskEntries = {
  "task.create": entry({
    resource: "task",
    verb: "create",
    name: "delegate_task",
    toolkit: "orchestrator",
    operation: "task",
    summary: "Delegate a child task",
    description:
      "Delegate one bounded task to a GOAT-owned child agent/subagent with a fresh prompt; goals and loops go to goat_thread_launch. No isolation shares the checkout; local worktree isolation omits uncommitted edits, cloud folder uploads may not. Completion wakes this thread: end the turn, don't poll; async children survive turn interruption. After an unknown remote launch keep taskId; do not relaunch.",
    guide:
      "Delegate a research lane, review round, or implementation slice from an active agent run in this GOAT thread. The child receives the supplied task prompt without parent conversation history. Children appear under their parent in the sidebar while relevant. The user can promote a child to a top-level thread, ending its task relationship here. Start work that owns a goal, runs HOTL, cxc-loop or repeated PABCD, or spans several cycles with goat_thread_launch so the user can see, steer and resume it.\n\nChoose providers and models with goat_provider_list, which uses the composer's live catalog. Prefer native subagent tools for same-provider work only if they support the chosen model and no model options are requested or inherited. Use goat_task_create for a model the native tool lacks, cross-provider work, or an explicitly GOAT-owned child. Also use it when options are requested, or when retaining the parent's instance and model with nonempty inheritedOptions from goat_provider_list; native subagents cannot reliably apply GOAT model options.\n\nFor each GOAT delegated review round, call goat_task_create again. Include the original brief, prior findings, responses and unresolved objections in the prompt. Record every finding's accepted or rebutted decision with evidence using goat_review_findings_record after each round. Keep each round's taskId and use a distinct clientRequestId that stays stable across retries of that round. childThreadId stores the child conversation; do not start another delegated review round with goat_thread_send.\n\nSet isolation='worktree' for a separate checkout based on the parent's local commit. Uncommitted edits are not copied. Cloud providers skip local worktree preparation; providers that upload the project folder, such as Claude Cloud, use its current checkout and may include local changes. Project setup runs before the child starts, except setup scripts configured as async can continue after it starts. Omit isolation to share the parent's checkout.\n\nProvider/model and modes inherit unless overridden. Options inherit only for the same provider instance and model. For local tasks, explicit options override individual inherited values; [] or {} clears them. Remote explicit options currently replace the inherited set. Set target.options with advertised IDs and values: Claude {effort: 'max', fastMode: true}; Codex {reasoningEffort: 'max', serviceTier: 'priority'}, when advertised by that model. Check providerInstanceId, model and options in the result.\n\nAn explicit runtimeMode must be listed in the target provider's runtimeModes from goat_provider_list. An inherited mode steps down to the broadest supported mode within the parent's ceiling. Leave runtimeMode unset unless the user asks for a supervised child; approval-required and auto-accept-edits can make it wait for a person on actions that need approval.\n\nPrefer mode='async' for long work. mode='wait' releases on completion, timeout, pending approval or a pending user-input question in the child thread. pendingRequestIds identifies questions to read and answer or forward; question release is not waitTimedOut. If hasPendingQuestion, pass threadId=childThreadId to goat_pending_request_list, goat_pending_request_read with requestId, and goat_pending_request_respond, or ask the user. Include host for remote child requests. The child keeps running and completion still wakes this thread.\n\nIf pendingApproval is set, consult the fresh full request in childThreadId before any response: the record can outlive its provider callback. It grants no approval authority. Decisions remain with the child's existing approval holder; agents inside GOAT use pending request tools for questions only and forward approvals to the user.\n\ntimeoutMs in mode='wait' limits the parent's wait and does not cancel the child. waitTimedOut means that wait expired without a releasing result; retain taskId and use goat_task_read later. Async completion notifies and wakes this thread, steering into active turns where supported or queuing otherwise. End the turn instead of polling or spawning watchers; use goat_task_read only if the result is needed mid-turn. An async child keeps running if this turn is interrupted or stopped. A wait child still waiting stops with the turn. An explicit full thread Stop cascade stops local delegated children, including async children. goat_task_cancel stops either mode.\n\nFor another machine, pass target.host as an SSH alias and remote.cwd, optionally remote.workspace. This needs a full-access/default caller. Models and options are checked on that host. Retain taskId after an unknown launch outcome; do not relaunch. The result includes host and a remote childThreadId that can be null. Parent Stop does not cancel remote tasks; use goat_task_cancel.",
    effect: "destructive",
    capability: "threads.launch",
    hostRoutable: false,
    requires: "thread",
    dryRun: "unsupported",
    humanSteps: ["approval"],
    annotations: {
      title: "Delegate a child task",
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
  "task.read": entry({
    resource: "task",
    verb: "read",
    name: "task_status",
    toolkit: "orchestrator",
    summary: "Get delegated task status",
    description:
      "Read status and results of this parent thread's GOAT-owned delegated task; reading a terminal result acknowledges automatic delivery. A completed turn with live nested work can still be unfinished. Later child-thread runs do not reopen a published task and can remain active after it ends.",
    guide:
      "Use childRunId to identify the original delegated run. workState distinguishes working, waiting_for_children and result_available. A completed turn with live nested work is not a completed task. summary is the final result, includes provider errors on failure and stays stable after publication.\n\nhasPendingChildRuns reports later queued or executing turns in the backing child thread, even after the task is terminal. It does not reopen the task. goat_task_cancel stops those turns too. Turns held in a stopped queue wait for the user and do not count.\n\nlatestTerminal* exposes later non-monitor turn results. latestTerminalSummary and latestTerminalResultContextTransferId independently become null when they exactly repeat summary and resultContextTransferId, respectively.\n\npendingApproval identifies the oldest pending live approval for this task's own unfinished work. Consult the fresh full request in childThreadId before responding: a record can outlive its provider callback and grants no approval authority. Decisions remain with the child's existing approval holder.\n\nReading a terminal result acknowledges its automatic parent delivery. Remote tasks return host, a remote childThreadId or null, summary-only results, pendingApproval=null, null context transfer/run IDs and hasPendingChildRuns=false. Later remote work is outside the task. Do not watch the remote child; completion already reaches the parent.",
    effect: "write",
    capability: "none",
    capabilityReason:
      "Reads the caller's own delegated tasks; a write only because reading settles their state.",
    hostRoutable: false,
    requires: "thread",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "Get delegated task status",
      idempotentHint: true,
      openWorldHint: true,
    },
  }),
  "task.cancel": entry({
    resource: "task",
    verb: "cancel",
    name: "task_cancel",
    toolkit: "orchestrator",
    summary: "Cancel delegated task",
    description:
      "Stop a GOAT-owned delegated task and its local child thread, including later runs. Nested local tasks stop and queued turns are held. Local cancellation drops the automatic completion wake; pending cloud work keeps it. Published results remain. Remote cancellation stays pending until the run stops; parent Stop does not cancel remote tasks.",
    guide:
      "Local cancellation normally disposes automatic parent delivery. Cloud-backed local tasks retain it while cloud cancellation or observation remains pending, so the eventual result can still reach the parent. The child stops like user Stop: interrupt the running turn, hold other queued turns, end pull request watches and stop its delegated local tasks. Cancel the task's own queued turn even when held in a stopped queue.\n\nThis also stops later child-thread runs after the task is terminal. A terminal task normally returns its existing status; orphan recovery can instead return cancelled when the parent still records active work whose child run is missing. Published results remain available. A child promoted to a top-level thread is no longer stopped by this task.\n\nRemote tasks request interruption of their launched run and return cancel_requested until it stops. Refused or unreachable cancellation preserves intent and the mailbox. A cancelled remote task's result still reaches the parent like any terminal result. Parent Stop does not cancel remote tasks.",
    effect: "destructive",
    capability: "none",
    capabilityReason:
      "Cancels only tasks this parent thread delegated, so narrowing a profile never strands its own work.",
    hostRoutable: false,
    requires: "thread",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "Cancel delegated task",
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
} as const;
