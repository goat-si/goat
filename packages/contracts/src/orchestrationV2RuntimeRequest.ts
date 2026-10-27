import * as Schema from "effect/Schema";

import { CommandId, RuntimeRequestId, ThreadId } from "./baseSchemas.ts";
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
  /** Deliver a message answer as the thread's next turn instead of steering its running one. */
  answerAsNextTurn: Schema.optional(Schema.Boolean),
});
