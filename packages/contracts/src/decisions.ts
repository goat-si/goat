import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { EnvironmentId, ThreadId, RuntimeRequestId } from "./baseSchemas.ts";
import { OrchestrationV2UserInputQuestion } from "./orchestrationV2.ts";
import { ProviderRequestKind, ProviderUserInputAnswers } from "./providerPolicy.ts";
import { PermissionProfile } from "./permissionProfiles.ts";

export const DecisionStatus = Schema.Literals(["open", "answered", "expired", "withdrawn"]);
export const DecisionOption = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  consequence: Schema.String,
});
export const DecisionItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  source: Schema.Literals(["decision", "pending_request"]),
  from: Schema.Struct({
    environmentId: Schema.optionalKey(EnvironmentId),
    threadId: Schema.optionalKey(ThreadId),
    host: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  title: TrimmedNonEmptyString,
  context: Schema.String,
  options: Schema.Array(DecisionOption),
  recommended: Schema.NullOr(Schema.String),
  requiredProfile: TrimmedNonEmptyString,
  expiresAt: Schema.NullOr(IsoDateTime),
  status: DecisionStatus,
  answer: Schema.NullOr(Schema.String),
  /** MCP retains the audit actor; authenticated client responses use a person-facing label. */
  answeredBy: Schema.NullOr(Schema.String),
  answeredByLabel: Schema.optionalKey(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  humanRequired: Schema.Boolean,
  pending: Schema.optionalKey(
    Schema.Struct({
      threadId: ThreadId,
      requestId: RuntimeRequestId,
      questions: Schema.Array(OrchestrationV2UserInputQuestion),
      approval: Schema.optionalKey(
        Schema.Struct({ kind: ProviderRequestKind, prompt: Schema.optionalKey(Schema.String) }),
      ),
    }),
  ),
});
export type DecisionItem = typeof DecisionItem.Type;
export const DecisionListInput = Schema.Struct({
  host: Schema.optionalKey(TrimmedNonEmptyString),
  hosts: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  status: Schema.optionalKey(DecisionStatus),
  limit: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 200 })),
  ),
});
export type DecisionListInput = typeof DecisionListInput.Type;
export const DecisionListResult = Schema.Struct({
  items: Schema.Array(DecisionItem),
  unavailableHosts: Schema.Array(
    Schema.Struct({
      host: TrimmedNonEmptyString,
      code: TrimmedNonEmptyString,
      message: Schema.String,
    }),
  ),
  truncated: Schema.Boolean,
});
export type DecisionListResult = typeof DecisionListResult.Type;
export const DecisionGetInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  host: Schema.optionalKey(TrimmedNonEmptyString),
});
export type DecisionGetInput = typeof DecisionGetInput.Type;
export const DecisionWithdrawInput = Schema.Struct({ id: TrimmedNonEmptyString });
export const DecisionRequestInput = Schema.Struct({
  title: TrimmedNonEmptyString,
  context: Schema.String,
  options: Schema.Array(DecisionOption).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  recommended: Schema.optionalKey(TrimmedNonEmptyString),
  requiredProfile: TrimmedNonEmptyString,
  expiresAt: Schema.optionalKey(IsoDateTime),
});
export type DecisionRequestInput = typeof DecisionRequestInput.Type;
export const DecisionAnswerInput = Schema.Struct({
  host: Schema.optionalKey(TrimmedNonEmptyString),
  id: TrimmedNonEmptyString,
  optionId: Schema.optionalKey(TrimmedNonEmptyString),
  answers: Schema.optionalKey(ProviderUserInputAnswers),
  decision: Schema.optionalKey(Schema.Literals(["accept", "decline"])),
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(2000)),
});
export type DecisionAnswerInput = typeof DecisionAnswerInput.Type;

// Foreign identity accompanies controls accepted only from an authenticated outside transport.
const transportFields = {
  transportEnvironmentId: Schema.optionalKey(EnvironmentId),
  permissionProfileCeiling: Schema.optionalKey(PermissionProfile),
};
export const DecisionListMcpInput = Schema.Struct({
  ...DecisionListInput.fields,
  ...transportFields,
  launcherEnvironmentId: Schema.optionalKey(EnvironmentId),
  launcherThreadId: Schema.optionalKey(ThreadId),
  localOnly: Schema.optionalKey(Schema.Boolean),
});
export type DecisionListMcpInput = typeof DecisionListMcpInput.Type;
export const DecisionGetMcpInput = Schema.Struct({
  ...DecisionGetInput.fields,
  ...transportFields,
});
export type DecisionGetMcpInput = typeof DecisionGetMcpInput.Type;
export const DecisionAnswerMcpInput = Schema.Struct({
  ...DecisionAnswerInput.fields,
  ...transportFields,
});
export type DecisionAnswerMcpInput = typeof DecisionAnswerMcpInput.Type;
