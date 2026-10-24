/**
 * reviewExport - the review-findings export's wire shapes: cursor codec, entry codec, and the
 * decision/outcome pairing. Split from OrchestratorMcpService so that file stays under its
 * recorded line budget.
 *
 * @module reviewExport
 */
import {
  IsoDateTime,
  ModelSelection,
  NodeId,
  NonNegativeInt,
  OrchestrationV2TaskRole,
  ReviewLedgerEntry,
  ThreadId,
  type OrchestratorMcpReviewFindingsRecordResult,
} from "@goat/contracts";
import * as Schema from "effect/Schema";

const ReviewExportCursor = Schema.fromJsonString(
  Schema.Struct({
    from: IsoDateTime,
    to: IsoDateTime,
    taskId: NodeId,
    index: NonNegativeInt,
  }),
);
export const decodeReviewExportCursor = Schema.decodeUnknownEffect(ReviewExportCursor);
export const encodeReviewExportCursor = Schema.encodeEffect(ReviewExportCursor);
const ReviewExportFields = {
  taskId: NodeId,
  threadId: ThreadId,
  role: Schema.optional(OrchestrationV2TaskRole),
  reviewerModel: Schema.NullOr(ModelSelection),
  authorModel: Schema.NullOr(ModelSelection),
};
export const encodeReviewExportEntry = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({
        ...ReviewLedgerEntry.members[0].fields,
        ...ReviewExportFields,
        latestOutcome: Schema.NullOr(ReviewLedgerEntry.members[1]),
      }),
      Schema.Struct({ ...ReviewLedgerEntry.members[1].fields, ...ReviewExportFields }),
    ]),
  ),
);

/** Latest decisions and any outcome recorded after that decision. */
export function reviewFindings(reviewLedger: ReadonlyArray<ReviewLedgerEntry>) {
  const findings = new Map<string, OrchestratorMcpReviewFindingsRecordResult["findings"][number]>();
  for (const entry of reviewLedger) {
    if (entry.kind === "decision")
      findings.set(entry.findingId, { decision: entry, latestOutcome: null });
    else {
      const finding = findings.get(entry.findingId);
      if (finding !== undefined)
        findings.set(entry.findingId, { ...finding, latestOutcome: entry });
    }
  }
  return [...findings.values()];
}
