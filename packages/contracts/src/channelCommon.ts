import * as Schema from "effect/Schema";

import { AuthEnvironmentScopes } from "./auth.ts";
import { EnvironmentId, IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RuntimeMode } from "./providerPolicy.ts";

/**
 * Shared vocabulary for channel input: where a message came from, who sent it, and where a
 * reply goes. The ledger, gateway, and reception contracts build on these; this module imports
 * only leaf schemas so orchestration items can carry channel metadata without a cycle.
 */

const makeChannelId = <Brand extends string>(brand: Parameters<typeof Schema.brand<Brand>>[0]) =>
  TrimmedNonEmptyString.pipe(Schema.brand<Brand>(brand));

export const ChannelConversationId = makeChannelId("ChannelConversationId");
export type ChannelConversationId = typeof ChannelConversationId.Type;
export const ChannelBindingId = makeChannelId("ChannelBindingId");
export type ChannelBindingId = typeof ChannelBindingId.Type;
export const ChannelTaskId = makeChannelId("ChannelTaskId");
export type ChannelTaskId = typeof ChannelTaskId.Type;
export const ChannelInputId = makeChannelId("ChannelInputId");
export type ChannelInputId = typeof ChannelInputId.Type;
/** One reception pass over an input. Not a coding `RunId`: no provider session backs it. */
export const ChannelReceptionId = makeChannelId("ChannelReceptionId");
export type ChannelReceptionId = typeof ChannelReceptionId.Type;
export const ChannelDeliveryId = makeChannelId("ChannelDeliveryId");
export type ChannelDeliveryId = typeof ChannelDeliveryId.Type;
export const ChannelQuestionId = makeChannelId("ChannelQuestionId");
export type ChannelQuestionId = typeof ChannelQuestionId.Type;
export const ChannelTaskEventId = makeChannelId("ChannelTaskEventId");
export type ChannelTaskEventId = typeof ChannelTaskEventId.Type;

export const ChannelKind = Schema.Literals(["goat", "slack", "mcp"]);
export type ChannelKind = typeof ChannelKind.Type;

/**
 * Where replies for a conversation go. Slack replies always target the thread root `rootTs`,
 * never the timestamp of a reply inside it. External timestamps stay strings.
 */
export const ChannelReplyAddress = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("goat"),
    environmentId: EnvironmentId,
    threadId: ThreadId,
  }),
  Schema.Struct({
    kind: Schema.Literal("slack"),
    connectionId: TrimmedNonEmptyString,
    teamId: TrimmedNonEmptyString,
    channelId: TrimmedNonEmptyString,
    rootTs: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("mcp"),
    connectionId: TrimmedNonEmptyString,
    requestNamespace: TrimmedNonEmptyString,
    conversationKey: TrimmedNonEmptyString,
  }),
]);
export type ChannelReplyAddress = typeof ChannelReplyAddress.Type;

/** What a transport observed about the sender. Never a source of permissions. */
export const ChannelActorRef = Schema.Struct({
  externalActorId: Schema.optional(TrimmedNonEmptyString),
  displayName: Schema.optional(TrimmedNonEmptyString),
  /** A local agent thread that sent the message, when one did. */
  senderThreadId: Schema.optional(ThreadId),
  senderEnvironmentId: Schema.optional(EnvironmentId),
});
export type ChannelActorRef = typeof ChannelActorRef.Type;

/**
 * Who asked for work, resolved by the server from authenticated context and identity links.
 * Stored as a snapshot on each task so later identity changes do not rewrite history.
 */
export const ChannelRequester = Schema.Struct({
  ownerId: TrimmedNonEmptyString,
  principalId: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  originKind: ChannelKind,
  externalActorId: Schema.optional(TrimmedNonEmptyString),
  runtimeModeCeiling: RuntimeMode,
  grantedScopes: AuthEnvironmentScopes,
});
export type ChannelRequester = typeof ChannelRequester.Type;

export const ChannelMessageKind = Schema.Literals([
  "inbound",
  "receipt",
  "status",
  "result",
  "question",
  "failure",
]);
export type ChannelMessageKind = typeof ChannelMessageKind.Type;

/**
 * Channel metadata on a GOAT bot message. `readAt` is when the reception service started
 * reading the input as context, not when a person viewed it.
 */
export const ChannelMessageMeta = Schema.Struct({
  conversationId: ChannelConversationId,
  originKind: ChannelKind,
  kind: ChannelMessageKind,
  inputId: Schema.optional(ChannelInputId),
  receptionId: Schema.optional(ChannelReceptionId),
  taskId: Schema.optional(ChannelTaskId),
  inReplyToInputId: Schema.optional(ChannelInputId),
  readAt: Schema.optional(IsoDateTime),
});
export type ChannelMessageMeta = typeof ChannelMessageMeta.Type;

/**
 * Why a transport could not deliver. Rate limits come with a retry delay. Timeouts and network
 * errors leave the outcome unknown. `not_in_channel`, `channel_not_found`, `invalid_auth`,
 * and `token_revoked` do not get better on retry.
 */
export const ChannelDeliveryErrorCode = Schema.Literals([
  "rate_limited",
  "not_in_channel",
  "channel_not_found",
  "invalid_auth",
  "token_revoked",
  "timeout",
  "network",
  "unknown",
]);
export type ChannelDeliveryErrorCode = typeof ChannelDeliveryErrorCode.Type;
