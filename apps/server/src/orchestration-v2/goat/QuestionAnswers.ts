import {
  CommandId,
  describeUserInputResponder,
  OrchestrationV2RuntimeRequest,
  ProviderApprovalDecision,
  RuntimeRequestId,
  UserInputRespondedBy,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

export class OrchestratorQuestionAlreadyAnsweredError extends Schema.TaggedError<OrchestratorQuestionAlreadyAnsweredError>()(
  "OrchestratorQuestionAlreadyAnsweredError",
  {
    commandId: CommandId,
    requestId: RuntimeRequestId,
    respondedBy: Schema.optional(UserInputRespondedBy),
    resolvedAt: Schema.NullOr(Schema.DateTimeUtc),
    decision: Schema.optional(ProviderApprovalDecision),
    status: Schema.optional(OrchestrationV2RuntimeRequest.fields.status),
  },
) {
  override get message(): string {
    const description = describeUserInputResponder(this);
    const time = this.resolvedAt === null ? "an unknown time" : DateTime.formatIso(this.resolvedAt);
    if (this.status === "expired")
      return `This question expired at ${time}, so it can no longer be answered.`;
    if (this.decision === "cancel" || this.status === "cancelled")
      return `This question was ${description} at ${time}, so it can no longer be answered.`;
    return `This question was already answered by ${description} at ${time}.`;
  }
}

/** The refusal for answering or dismissing a question that is no longer pending. */
export const questionAlreadyAnswered = (
  command: { readonly commandId: CommandId; readonly requestId: RuntimeRequestId },
  request: Pick<
    OrchestrationV2RuntimeRequest,
    "respondedBy" | "decision" | "status" | "resolvedAt"
  >,
) =>
  new OrchestratorQuestionAlreadyAnsweredError({
    commandId: command.commandId,
    requestId: command.requestId,
    ...(request.respondedBy === undefined ? {} : { respondedBy: request.respondedBy }),
    ...(request.decision === undefined ? {} : { decision: request.decision }),
    status: request.status,
    resolvedAt: request.resolvedAt,
  });
