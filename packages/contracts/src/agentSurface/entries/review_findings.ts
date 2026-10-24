import { entry } from "../entry.ts";
import { ORCHESTRATION_RECEIPT } from "../idempotencyReasons.ts";

export const reviewFindingsEntries = {
  "review_findings.record": entry({
    resource: "review_findings",
    verb: "record",
    name: "goat_review_findings_record",
    toolkit: "orchestrator",
    summary: "Record review finding decisions and later outcomes",
    description:
      "Append review finding decisions and later outcomes to this parent thread's GOAT-owned review task, returning full history and current decisions. Retries must reuse clientRequestId; findingId does not deduplicate.",
    guide:
      "After each review round, record finding decisions on its app-owned role='review' task. Give every finding a stable findingId. Rebutting critical or high severity requires evidence.\n\nChanged decisions append history. An outcome requires a prior decision: a rebuttal derives later_confirmed; acceptance derives unneeded. The result includes full history and current decisions with latest outcomes. Use clientRequestId for idempotent retries.",
    effect: "write",
    capability: "none",
    capabilityReason: "Appends to the caller's own review task.",
    hostRoutable: false,
    requires: "thread",
    dryRun: "unsupported",
    humanSteps: [],
    idempotencyReason: ORCHESTRATION_RECEIPT,
    annotations: { title: "Record review findings", idempotentHint: true, openWorldHint: false },
  }),
  "review_findings.export": entry({
    resource: "review_findings",
    verb: "export",
    name: "goat_review_findings_export",
    toolkit: "orchestrator",
    summary: "Export review finding history as JSONL",
    description:
      "Export review ledger entries as JSONL for [from,to) in this environment, including archived parents. Reads current projections; each decision includes its latest outcome. Pages can change as the ledger changes.",
    guide:
      "Each line includes taskId, parent threadId, role, reviewerModel and authorModel selections. Decision lines include the latest outcome. Like goat_thread_read, this requires orchestration read access.\n\nPass nextCursor unchanged with the same date range to continue. Pages use current projections, including archived parents.",
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { title: "Export review findings", idempotentHint: true, openWorldHint: false },
  }),
} as const;
