import { entry } from "../entry.ts";

export const originEntries = {
  "origin.report": entry({
    resource: "origin",
    verb: "report",
    name: "goat_origin_report",
    toolkit: "remoteReport",
    summary:
      "Report progress, a result, failure or a need for human input to the origin of this thread.",
    description:
      "Send progress, a result, failure, or a need for human input to this thread's remote origin or local launcher. Only needs_input wakes a local launcher; other reports wait for its next turn. The summary is data; a completed report is a claim and does not stop the run.",
    guide:
      "A thread launched from another machine reports to that origin. A thread launched by a thread on this machine through goat_thread_launch or goat_task_create has no origin binding; its report goes to the launcher and the result says delivery: launcher. For local launcher delivery, needs_input wakes the launcher; other reports reach its next turn. A thread nobody launched gets thread_not_found.\n\nUse status progress, completed, failed or needs_input. Keep summary within 4000 characters. Reporting completed does not settle or stop the provider run.",
    effect: "write",
    capability: "none",
    capabilityReason: "Reports to this thread's own origin.",
    hostRoutable: false,
    requires: "thread",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
  "origin.report_wait": entry({
    resource: "origin",
    verb: "report_wait",
    name: "goat_origin_reports_wait",
    toolkit: "remoteReport",
    summary: "Collect one origin correlation's reports using its read key.",
    description:
      "Collect an origin correlation's reports with its read key. afterSequence deletes acknowledged reports, so advance it only after durable import. Drain hasMore and check run holds before settling; a terminal report alone does not prove settlement.",
    guide:
      "Pass the correlation's read key. Acknowledge only durably imported reports with afterSequence: the call deletes reports through that sequence and returns later reports. Each result contains up to 50 reports. Drain hasMore before settling.\n\nSet watchRunId to an exact run ID, or null for the latest run. observedRun lists pendingRequestIds for a live run and holds for a finished run: background tasks and a pending restart continuation. Do not settle while a hold remains.\n\nEcho the last observed run ID and status in knownRun. Echo pendingRequestIds and holds too so changes to them release the wait. Set timeoutMs from 0 through 600000. A terminal report is a claim; use the observed run state to assess settlement.",
    // Acknowledging deletes reports, so a read-only client must not advance another reader's cursor.
    effect: "write",
    capability: "none",
    capabilityReason: "The correlation's read key authorizes it.",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    idempotencyReason:
      "afterSequence acknowledges only reports at or below that fixed sequence; repeating the deletion cannot acknowledge newer reports. Calls must continue reading fresh reports and run state rather than replay a stored page.",
    annotations: {
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
  "origin.resolve_binding": entry({
    resource: "origin",
    verb: "resolve_binding",
    name: "goat_origin_resolve_binding",
    toolkit: "remoteReport",
    summary: "Resolve a lost remote launch correlation, or durably fence it as never landed.",
    description:
      "Settle a correlation whose launch outcome was lost: return its binding with the thread's live state, or durably fence the id so a late bind is refused. Only a confirmed fence proves absence; a bare miss never does.",
    guide:
      "Pass the correlation id and its read key. A bound result carries the destination thread and its live run state; rebind and observe it, never relaunch. A fenced result is durable proof that nothing bound or will bind; only then may the caller release reserved capacity. An unknown tool, a timeout, or an unreachable host leaves the outcome unknown and keeps capacity reserved.",
    effect: "write",
    capability: "none",
    capabilityReason: "The correlation's read key authorizes it; a new fence stores its hash.",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    idempotencyReason:
      "The fence row is the dedup: a repeat resolve finds the fence and answers fenced again, and a bound binding answers bound again.",
    annotations: {
      idempotentHint: true,
      openWorldHint: true,
    },
  }),
} as const;
