/**
 * GOAT review rounds: the finding ledger a review task records, and continuing an earlier review
 * round in the same reviewer conversation. Kept apart from orchestrationV2.ts, which re-exports it.
 *
 * @module reviewLedger
 */
import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  NodeId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { MemoryTaskGrantCeilingField } from "./memory.ts";
import { ModelSelection } from "./modelSelection.ts";

/** Nested timestamps stay strings so projection JSON round-trips preserve them. */
export const ReviewLedgerDecisionInput = Schema.Struct({
  kind: Schema.Literal("decision"),
  findingId: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  severity: Schema.Literals(["critical", "high", "medium", "low", "info"]),
  cites: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(4_000))),
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
  decision: Schema.Literals(["accepted", "rebutted"]),
  evidence: Schema.NullOr(
    Schema.Struct({
      kind: Schema.Literals(["command", "location", "commit", "test", "other"]),
      ref: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
      exitCode: Schema.optional(Schema.Int),
    }),
  ),
});
export const ReviewLedgerOutcomeInput = Schema.Struct({
  kind: Schema.Literal("outcome"),
  findingId: ReviewLedgerDecisionInput.fields.findingId,
  link: Schema.Struct({
    kind: Schema.Literals(["commit", "test", "revert", "issue", "other"]),
    ref: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
  }),
});
export const ReviewLedgerEntryInput = Schema.Union([
  ReviewLedgerDecisionInput,
  ReviewLedgerOutcomeInput,
]);
export type ReviewLedgerEntryInput = typeof ReviewLedgerEntryInput.Type;
const ReviewLedgerRecordedFields = {
  entryId: TrimmedNonEmptyString,
  recordedAt: IsoDateTime,
  recordedByRunId: Schema.NullOr(RunId),
};
export const ReviewLedgerEntry = Schema.Union([
  Schema.Struct({ ...ReviewLedgerDecisionInput.fields, ...ReviewLedgerRecordedFields }),
  Schema.Struct({
    ...ReviewLedgerOutcomeInput.fields,
    ...ReviewLedgerRecordedFields,
    outcome: Schema.Literals(["later_confirmed", "unneeded"]),
  }),
]);
export type ReviewLedgerEntry = typeof ReviewLedgerEntry.Type;

/**
 * Starts a new review task in an earlier review task's child thread, continuing its provider
 * conversation. threadId is the parent thread, which owns both tasks.
 */
export const OrchestrationV2ReviewContinueCommand = Schema.Struct({
  type: Schema.Literal("delegated_task.review-continue"),
  commandId: CommandId,
  threadId: ThreadId,
  parentRunId: RunId,
  parentNodeId: NodeId,
  continueFrom: NodeId,
  childThreadId: ThreadId,
  task: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: ModelSelection,
  completionWake: Schema.Literals(["always", "settled_only"]),
  memoryGrantCeiling: MemoryTaskGrantCeilingField,
  createdBy: Schema.Literal("agent"),
  creationSource: Schema.Literal("mcp"),
});
export type OrchestrationV2ReviewContinueCommand = typeof OrchestrationV2ReviewContinueCommand.Type;

export const OrchestratorMcpContinueFrom = NodeId.annotate({
  description:
    "Review rounds only: an earlier finished review taskId of this thread. Continues that reviewer's conversation as a new task with its own ledger.",
});

/**
 * Where a review round ran. continued: the provider completed this round's brief in the earlier
 * round's native conversation. Any other value for a continued round means it did not, or GOAT
 * cannot tell; the tool description lists them.
 */
export const OrchestratorMcpReviewRound = Schema.Struct({
  continuedFrom: Schema.NullOr(NodeId),
  conversation: Schema.Literals([
    "new",
    "starting",
    "not_started",
    "continued",
    "recovered",
    "rewound",
    "unverified",
  ]),
  compacted: Schema.Boolean,
});
export type OrchestratorMcpReviewRound = typeof OrchestratorMcpReviewRound.Type;
