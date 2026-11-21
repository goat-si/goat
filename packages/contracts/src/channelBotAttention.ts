import * as Schema from "effect/Schema";
import { EnvironmentId, IsoDateTime, NonNegativeInt, ThreadId } from "./baseSchemas.ts";
import { BotId } from "./botProfile.ts";
import { ChannelTaskApprovalRef } from "./channelWorkerObservation.ts";
import { ChannelTaskId } from "./channelCommon.ts";

export const GoatBotAlerts = Schema.Literals(["needs_you", "needs_you_and_results", "off"]);
export type GoatBotAlerts = typeof GoatBotAlerts.Type;

export const ChannelAttentionKind = Schema.Literals([
  "question",
  "approval",
  "sign_in",
  "failed",
  "finished",
]);
export type ChannelAttentionKind = typeof ChannelAttentionKind.Type;

export const ChannelAttentionRequest = Schema.Struct({
  ...ChannelTaskApprovalRef.fields,
  kind: Schema.Literals(["runtime", "handoff"]),
});
export type ChannelAttentionRequest = typeof ChannelAttentionRequest.Type;

export const ChannelAttentionTarget = Schema.Struct({
  environmentId: EnvironmentId,
  botId: BotId,
  taskId: ChannelTaskId,
  requestId: Schema.optionalKey(Schema.String),
  request: Schema.optionalKey(ChannelAttentionRequest),
  generation: Schema.optionalKey(NonNegativeInt),
});
export type ChannelAttentionTarget = typeof ChannelAttentionTarget.Type;

export const ChannelAttentionEvent = Schema.Struct({
  ...ChannelAttentionTarget.fields,
  eventId: Schema.String,
  sequence: NonNegativeInt,
  kind: ChannelAttentionKind,
  generation: Schema.Int,
  occurredAt: IsoDateTime,
  botName: Schema.String,
});
export type ChannelAttentionEvent = typeof ChannelAttentionEvent.Type;

export const ChannelAttentionFeedInput = Schema.Struct({
  cursor: Schema.optionalKey(NonNegativeInt),
  worker: Schema.optionalKey(Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId })),
});
export type ChannelAttentionFeedInput = typeof ChannelAttentionFeedInput.Type;
export const ChannelAttentionFeedResult = Schema.Struct({
  cursor: NonNegativeInt,
  hasMore: Schema.Boolean,
  mode: GoatBotAlerts,
  ownsWorker: Schema.optionalKey(Schema.Boolean),
  events: Schema.Array(ChannelAttentionEvent).check(Schema.isMaxLength(50)),
});
export type ChannelAttentionFeedResult = typeof ChannelAttentionFeedResult.Type;
