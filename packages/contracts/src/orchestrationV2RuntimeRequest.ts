import * as Schema from "effect/Schema";

import { CommandId, RunId, RuntimeRequestId, ThreadId } from "./baseSchemas.ts";
import {
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
  UserInputAttachments,
  UserInputRespondedBy,
} from "./providerPolicy.ts";

/** An answer or decision for a pending runtime request. */
export const RuntimeRequestRespondCommand = Schema.Struct({
  type: Schema.Literal("runtime-request.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: RuntimeRequestId,
  decision: Schema.optional(ProviderApprovalDecision),
  feedback: Schema.optional(Schema.String),
  answers: Schema.optional(ProviderUserInputAnswers),
  attachmentsByQuestionId: Schema.optional(UserInputAttachments),
  respondedBy: Schema.optional(UserInputRespondedBy),
  /** The only running turn an agent's message answer may join; otherwise it is the next turn. */
  answerSteersRunId: Schema.optional(RunId),
});
