import { entry } from "../entry.ts";

export const reviewFindingsEntries = {
  "review_findings.record": entry({
    resource: "review_findings",
    verb: "record",
    name: "goat_review_findings_record",
    toolkit: "orchestrator",
    summary: "Record review finding decisions and later outcomes",
    description:
      "After each review round, append finding decisions to the parent thread's app-owned role=review task. Give each finding a stable findingId. Rebutting critical or high severity requires evidence. Changed decisions append history; outcomes require a decision and derive later_confirmed for a rebuttal or unneeded for acceptance. Returns full history and current decisions with latest outcomes. Use clientRequestId for idempotent retries.",
    effect: "write",
    capability: "none",
    capabilityReason: "Appends to the caller's own review task.",
    hostRoutable: false,
    requires: "thread",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { title: "Record review findings", idempotentHint: true, openWorldHint: false },
  }),
  "review_findings.export": entry({
    resource: "review_findings",
    verb: "export",
    name: "goat_review_findings_export",
    toolkit: "orchestrator",
    summary: "Export review finding history as JSONL",
    description:
      "Export review ledger entries recorded in [from,to) in this environment, including archived parents. Each line includes taskId, parent threadId, role, reviewerModel and authorModel selections, plus the latest outcome for decisions. Like goat_thread_read, requires orchestration read access. Pass nextCursor unchanged with the same date range to continue; pages use current projections.",
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { title: "Export review findings", idempotentHint: true, openWorldHint: false },
  }),
} as const;
