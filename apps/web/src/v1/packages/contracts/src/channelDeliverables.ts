import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ChannelChildWorkId } from "./channelChildWork.ts";

export const ChannelDeliverableId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-zA-Z0-9_-]{1,64}$/),
);
export const ChannelDeliverableSpec = Schema.Struct({
  id: ChannelDeliverableId,
  criterion: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type ChannelDeliverableSpec = typeof ChannelDeliverableSpec.Type;

const review = {
  decision: Schema.Literals(["accepted", "rejected"]),
  evidence: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  childWorkId: ChannelChildWorkId,
};
export const ChannelDeliverable = Schema.Struct({
  ...ChannelDeliverableSpec.fields,
  attempt: PositiveInt,
  review: Schema.optionalKey(Schema.Struct(review)),
});
export type ChannelDeliverable = typeof ChannelDeliverable.Type;

export const ChannelDeliverableReview = Schema.Struct({
  id: ChannelDeliverableId,
  attempt: PositiveInt,
  decision: review.decision,
  evidence: review.evidence,
});
export const ChannelDeliverableView = Schema.Struct({
  ...ChannelDeliverableSpec.fields,
  attempt: PositiveInt,
  state: Schema.Literals(["pending", "running", "awaiting_acceptance", "accepted", "failed"]),
  childWorkId: Schema.optionalKey(ChannelChildWorkId),
  host: Schema.optionalKey(TrimmedNonEmptyString),
  evidence: Schema.optionalKey(review.evidence),
});
export type ChannelDeliverableView = typeof ChannelDeliverableView.Type;

export const ChannelDeliverableSpecs = Schema.Array(ChannelDeliverableSpec).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(16),
  Schema.makeFilter(
    (items) =>
      new Set(items.map((item) => item.id)).size === items.length ||
      "Required deliverable IDs must be unique.",
  ),
);
export const ChannelDeliverables = Schema.Array(ChannelDeliverable).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(16),
);

/** task.create's existing idempotency key also identifies one attempt to deliver this item. */
export const requiredDeliverableRequestKey = (id: string, attempt: number) =>
  "required:" + id + ":" + attempt;
