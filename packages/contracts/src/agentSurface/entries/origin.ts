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
      "Send progress, a result, failure, or a need for human input to this thread's remote origin or local launcher. Only needs_input wakes a local launcher; other reports wait for its next turn. The summary is data; a completed report is a claim and does not stop the run. Retry with the same clientRequestId.",
    guide:
      "A thread launched from another machine reports to that origin. A thread launched by a thread on this machine through goat_thread_launch or goat_task_create has no origin binding; its report goes to the launcher and the result says delivery: launcher. For local launcher delivery, needs_input wakes the launcher; other reports reach its next turn. A thread nobody launched gets thread_not_found.\n\nUse status progress, completed, failed or needs_input. Keep summary within 4000 characters. Reporting completed does not settle or stop the provider run.\n\nWith clientRequestId, a repeat of the same report returns its first receipt and never reports twice, and the same key with another report is refused. goat_origin_report_receipt reads a keyed report's receipt, also after the origin collected it.",
    idempotencyReason:
      "Stores clientRequestId as a receipt in the same transaction as the origin's report row or the launcher's inbox entry, and derives a launcher wake's command id from it, so a repeat returns the first receipt and sends a recorded wake at most once; another report under the key is refused.",
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
  "origin.report_receipt": entry({
    resource: "origin",
    verb: "report_receipt",
    name: "goat_origin_report_receipt",
    toolkit: "remoteReport",
    summary: "Read this thread's receipt for a keyed origin report.",
    description:
      "Read whether this thread already made the goat_origin_report sent with a clientRequestId, and where it went. Changes nothing; the receipt outlives the origin collecting the report.",
    guide:
      "Pass the clientRequestId of an earlier goat_origin_report from this thread. receipt is null when no report under that key was recorded; report again with the same key. delivered:false means a launcher wake was recorded but not confirmed sent: repeat the report with the same key, which sends it at most once. Only the reporting thread can read its receipts.",
    effect: "read",
    hostRoutable: false,
    requires: "thread",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      idempotentHint: true,
      openWorldHint: false,
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
} as const;
