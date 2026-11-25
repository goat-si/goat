import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ChannelTaskEventId, ChannelTaskId } from "./channelCommon.ts";
import { ChannelDeliverableSpecs, ChannelDeliverableReview } from "./channelDeliverables.ts";
import { ChannelDeliverableRetry } from "./channelDeliverableRetry.ts";
import { ChannelTaskDoneMeans } from "./channelLedger.ts";
import { ChannelSkillProposal } from "./channelSkillProposal.ts";

/**
 * A worker's report on its assigned task. The sender's identity and thread come from the MCP
 * invocation, not from this payload, and must match the task's current assignment.
 */
export const ChannelTaskReportInput = Schema.Struct({
  requiredDeliverables: Schema.optionalKey(
    ChannelDeliverableSpecs.annotate({
      description:
        "Declare every mandatory child result before launching workers. On task.create use clientRequestId required:<id>:1 for each item.",
    }),
  ),
  retryDeliverable: Schema.optionalKey(ChannelDeliverableRetry),
  reviewDeliverable: Schema.optionalKey(
    ChannelDeliverableReview.annotate({
      description:
        "Review the current child result against the declared criterion. Cite specific evidence. Accept only if the criterion was met.",
    }),
  ),
  taskId: ChannelTaskId,
  eventId: ChannelTaskEventId,
  generation: PositiveInt,
  status: Schema.Literals(["running", "waiting_input", "completed", "failed"]),
  summary: TrimmedNonEmptyString,
  doneMeans: Schema.optionalKey(
    ChannelTaskDoneMeans.annotate({
      description:
        "On the first running report from a GOAT Bot session, a one-sentence completion criterion for the work it is starting.",
    }),
  ),
  milestone: Schema.optional(Schema.Boolean),
  question: Schema.optional(TrimmedNonEmptyString),
  /** Only on a completed report; see ChannelSkillProposal. */
  skillProposal: Schema.optional(ChannelSkillProposal),
});
export type ChannelTaskReportInput = typeof ChannelTaskReportInput.Type;
