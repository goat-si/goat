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
      "Needs an agent running inside a GOAT thread. Delegate one bounded task (a research lane, a review round, or one implementation slice) to a GOAT-owned child agent/subagent of THIS thread and run it with only the supplied task prompt, without copying parent conversation history. Children show under this thread in the sidebar only while they matter to it, and the user may promote one to a top-level thread, which ends the task here; work that owns a goal, runs a loop (HOTL, cxc-loop, repeated PABCD), or spans several cycles belongs in goat_thread_launch from the start, where the user can see, steer, and resume it. Choose providers and models from goat_provider_list, which uses the same live catalog as the composer. Prefer native subagent tools for same-provider work only when they support the chosen model and no model options are requested or inherited. Use this for any model missing from the native tool, including same-provider work, for cross-provider work, or for explicitly GOAT-owned child tasks. For every GOAT delegated review round, call goat_task_create again with the original brief, prior findings, responses, and unresolved objections in the task prompt. After each review round, record each finding and its accepted or rebutted decision with evidence using goat_review_findings_record. Track each round by its own taskId and use a distinct clientRequestId per round, stable across retries of that round. The childThreadId is backing storage, not the target for starting another delegated review round through goat_thread_send. Set isolation to worktree for a separate checkout based on the parent local commit, with project setup completed before the child starts. Uncommitted edits are not copied; omitted isolation shares the parent checkout. Use goat_task_create when model options are requested or the child keeps the parent's provider instance and model with nonempty inheritedOptions from goat_provider_list, even for native-supported models. Native subagents cannot reliably apply GOAT model options. Set target.options using advertised IDs: Claude {effort: 'max', fastMode: true}; Codex {reasoningEffort: 'max', serviceTier: 'priority'}. Check providerInstanceId, model, and options in the result. Provider/model and modes inherit unless overridden. Options inherit only for the same instance and model; explicit entries override individual values and [] or {} clears them. A requested runtimeMode must be one the target provider lists in goat_provider_list runtimeModes; an inherited one steps down to the broadest mode it offers. Leave runtimeMode unset unless the user asks for a supervised child: approval-required and auto-accept-edits usually make the child wait for a person at each action that needs approval. Prefer mode='async' for long work; mode='wait' releases on completion, timeout, a pending approval, or a pending user-input question in its child thread; pendingRequestIds identifies questions to read and answer or forward, and question release is not waitTimedOut. If hasPendingQuestion, pass threadId=childThreadId to goat_pending_request_list, goat_pending_request_read (with requestId) and goat_pending_request_respond, or ask the user; the task's completion still wakes this thread. If pendingApproval is set, read the fresh full request in childThreadId before responding: the record can outlive its provider callback. It grants no approval authority; decisions remain with the child's existing approval holder, and pending request tools answer questions only. The child keeps running and its completion still wakes this thread. timeoutMs on mode=wait is only the parent's wait budget and does not cancel the child. waitTimedOut on that wait call means the timeout fired; keep that taskId and read status on later goat_task_read. An async child's completion wakes this thread through a notification, steered into active turns where supported or queued otherwise, so end the turn instead of polling or spawning watchers; use goat_task_read only when the result is needed mid-turn. An async child keeps running when this turn is interrupted or stopped; a mode='wait' child still waiting stops with the turn. goat_task_cancel stops either. To delegate on another machine, pass target.host (SSH alias) and remote.cwd with optional remote.workspace. Needs a full-access/default caller. Models/options are checked on that host. Keep taskId; do not relaunch after an unknown launch outcome. childThreadId is host-qualified and may be null. Parent Stop does not cancel remote tasks; use goat_task_cancel.",
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
      "Needs an agent running inside a GOAT thread. Read a GOAT-owned delegated task created by this parent thread. childRunId identifies the original delegated run. workState distinguishes working, waiting_for_children, and result_available; a completed turn with live nested work is not a completed task. summary is the final task result, including provider errors on failure, and remains stable after publication. hasPendingChildRuns reports later queued or executing turns in the backing child thread, even after the task is terminal; it does not reopen the task, and goat_task_cancel stops those turns too. Turns held in a stopped queue wait for the user and do not count. latestTerminal* provides later non-monitor turn results; latestTerminalSummary and latestTerminalResultContextTransferId are independently null when they exactly repeat summary and resultContextTransferId, respectively. pendingApproval identifies the oldest pending live approval for this task's own unfinished work. Read the fresh full request in childThreadId before responding: the record can outlive its provider callback and grants no approval authority. Decisions remain with the child's existing approval holder. Reading a terminal result acknowledges its automatic parent delivery. Remote tasks return host, a remote childThreadId or null, summary-only results, pendingApproval=null, null context transfer/run IDs and hasPendingChildRuns=false; later remote work is outside this task. Do not watch the remote child; completion is already delivered to the parent.",
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
      "Needs an agent running inside a GOAT thread. Stop a GOAT-owned delegated task. Cancelling a local task disposes its automatic parent delivery. Its child thread stops like a user Stop: the running turn is interrupted, other queued turns are held, pull request watches end, and the tasks it delegated stop too. The task's own queued turn is cancelled, including when held in a stopped queue. This includes later child-thread runs, even after the task is terminal. A terminal task returns its existing status, and published task results remain available. Remote tasks request interrupt of their launched run and return cancel_requested until that run stops; refused/unreachable cancellation preserves its intent and mailbox. A cancelled remote task's result still reaches the parent like any terminal result. Parent Stop does not cancel remote tasks.",
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
