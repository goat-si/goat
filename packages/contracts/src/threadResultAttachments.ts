import * as Schema from "effect/Schema";
import { MessageId, RunAttemptId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ChatAttachmentId } from "./chatAttachment.ts";

export const ThreadResultAttachmentRef = Schema.Struct({
  messageId: MessageId,
  attachmentId: ChatAttachmentId,
});
export const ThreadResultAttachments = Schema.Array(
  Schema.Struct({
    ...ThreadResultAttachmentRef.fields,
    attemptId: RunAttemptId,
    name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  }),
).check(Schema.isMaxLength(128));
