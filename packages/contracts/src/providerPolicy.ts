import {
  ChatImageAttachment,
  ChatFileAttachment,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "./chatAttachment.ts";
import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ProviderApprovalPolicy = Schema.Literals([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);
export type ProviderApprovalPolicy = typeof ProviderApprovalPolicy.Type;

export const ProviderSandboxMode = Schema.Literals([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type ProviderSandboxMode = typeof ProviderSandboxMode.Type;

export const RuntimeMode = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
export type RuntimeMode = typeof RuntimeMode.Type;
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

export const ProviderInteractionMode = Schema.Literals(["default", "plan"]);
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type;
export const DEFAULT_PROVIDER_INTERACTION_MODE: ProviderInteractionMode = "default";

export const ProviderRequestKind = Schema.Literals([
  "command",
  "file-read",
  "file-change",
  "mcp-elicitation",
  "permission",
]);
export type ProviderRequestKind = typeof ProviderRequestKind.Type;

export const AssistantDeliveryMode = Schema.Literals(["buffered", "streaming"]);
export type AssistantDeliveryMode = typeof AssistantDeliveryMode.Type;

export const ProviderApprovalDecision = Schema.Literals([
  "accept",
  "acceptForSession",
  "acceptAlways",
  "decline",
  "cancel",
]);
export type ProviderApprovalDecision = typeof ProviderApprovalDecision.Type;

// Why an approval reached the user although the thread runs with full access:
// the user's own ask rule, or a check the provider enforces even when bypassed.
export const ProviderApprovalFullAccessOverride = Schema.Literals(["ask_rule", "provider_check"]);
export type ProviderApprovalFullAccessOverride = typeof ProviderApprovalFullAccessOverride.Type;

export const ProviderApprovalOption = Schema.Struct({
  decision: ProviderApprovalDecision,
  label: TrimmedNonEmptyString,
  warning: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderApprovalOption = typeof ProviderApprovalOption.Type;

export const ProviderUserInputAnswers = Schema.Record(Schema.String, Schema.Unknown);
export type ProviderUserInputAnswers = typeof ProviderUserInputAnswers.Type;

export const UserInputAttachments = Schema.Record(
  Schema.String,
  Schema.Array(Schema.Union([ChatImageAttachment, ChatFileAttachment])).pipe(
    Schema.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
);
export type UserInputAttachments = typeof UserInputAttachments.Type;

export const UserInputResponseReason = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2000),
  Schema.isPattern(/\S/),
);
export type UserInputResponseReason = typeof UserInputResponseReason.Type;

export const UserInputRespondedBy = Schema.Union([
  Schema.Struct({ type: Schema.Literal("user") }),
  Schema.Struct({
    type: Schema.Literal("agent"),
    threadId: ThreadId,
    environmentId: Schema.NullOr(EnvironmentId),
    title: Schema.NullOr(Schema.String),
    reason: UserInputResponseReason,
    /** Agent-reported claim that this answer relays the user's own decision. */
    relayedFromUser: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("client"),
    /** The MCP client session's label, when the server knew it. */
    label: Schema.optional(TrimmedNonEmptyString),
    reason: UserInputResponseReason,
  }),
]);
export type UserInputRespondedBy = typeof UserInputRespondedBy.Type;

/** Describes the recorded responder or terminal outcome without exposing the answer or reason. */
export function describeUserInputResponder(input: {
  respondedBy?: UserInputRespondedBy | undefined;
  decision?: ProviderApprovalDecision | undefined;
  status?: "pending" | "resolved" | "expired" | "cancelled" | undefined;
}): string {
  if (input.status === "expired") return "expired";
  if (input.status === "cancelled") return "cancelled";
  if (input.decision === "cancel") {
    return input.respondedBy?.type === "user"
      ? "dismissed by the user"
      : "closed when its thread stopped or settled";
  }
  const responder = input.respondedBy;
  switch (responder?.type) {
    case "user":
      return "the user";
    case "agent":
      return `${responder.relayedFromUser === true ? "the user, relayed by " : ""}orchestrator "${responder.title ?? responder.threadId}"${responder.environmentId === null ? "" : " on another machine"}`;
    case "client":
      return responder.label === undefined ? "an MCP client" : `MCP client "${responder.label}"`;
    default:
      return "another responder";
  }
}

export const UserInputAttachmentAnswerPayload = Schema.Struct({
  respondedBy: Schema.optional(UserInputRespondedBy),
  requestId: TrimmedNonEmptyString,
  questionTextById: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  answers: ProviderUserInputAnswers,
  attachmentsByQuestionId: UserInputAttachments,
});
export type UserInputAttachmentAnswerPayload = typeof UserInputAttachmentAnswerPayload.Type;
