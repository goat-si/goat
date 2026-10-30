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
    parameters: {
      taskId: "The role review task whose findings these are.",
      entries:
        "1 to 100 entries. A decision: {kind:'decision', findingId, severity, cites, summary, decision:'accepted'|'rebutted', evidence}. A later outcome: {kind:'outcome', findingId, link:{kind, ref}}.",
    },
    examples: [
      {
        title: "Accept one finding and rebut another",
        args: {
          taskId: "<taskId>",
          clientRequestId: "checkout-review-1-findings",
          entries: [
            {
              kind: "decision",
              findingId: "F1",
              severity: "high",
              cites: "src/checkout.ts:42",
              summary: "Race between reserve and charge.",
              decision: "accepted",
              evidence: null,
            },
            {
              kind: "decision",
              findingId: "F2",
              severity: "low",
              cites: "src/checkout.ts:90",
              summary: "Rename suggestion.",
              decision: "rebutted",
              evidence: {
                kind: "location",
                ref: "src/checkout.ts:88 already follows the module's naming",
              },
            },
          ],
        },
      },
    ],
    effect: "write",
    capability: "none",
    capabilityReason: "Appends to the caller's own review task.",
    hostRoutable: false,
    requires: "thread",
    dryRun: "unsupported",
    humanSteps: [],
    idempotency: "domain",
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
      "Each line includes taskId, parent threadId, role, reviewerModel and authorModel selections, and continuedFrom: the earlier round's taskId when the reviewer continued one, else null. Decision lines include the latest outcome. Like goat_thread_read, this requires orchestration read access.\n\nPass nextCursor unchanged with the same date range to continue. Pages use current projections, including archived parents.",
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { title: "Export review findings", idempotentHint: true, openWorldHint: false },
  }),
} as const;
