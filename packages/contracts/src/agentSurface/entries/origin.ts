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
      "Report progress, a result, failure or a need for human input to the origin of this thread. A thread launched from another machine reports to that origin. A thread launched by a thread on this machine (goat_thread_launch, goat_task_create) has no origin binding, so its report goes to that launcher instead and the result says delivery: launcher; needs_input wakes the launcher, other reports reach its next turn. A thread nobody launched gets thread_not_found. The summary is data; a completed report is a claim and does not stop the run. Maximum 4000 characters.",
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
      "Collect one origin correlation's reports using its read key. afterSequence acknowledges only durably imported reports. Returns up to 50 reports; drain hasMore before settling. watchRunId selects an exact run, null selects latest. observedRun lists a live run's pendingRequestIds and a finished run's holds (background tasks, a pending restart continuation); do not settle while a hold remains. knownRun tracks its last observed identity and status, plus pendingRequestIds and holds when echoed back; timeoutMs is 0..600000. A terminal report is not proof of run settlement.",
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
} as const;
