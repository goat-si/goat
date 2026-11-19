import { ChatAttachment } from "./chatAttachment.ts";
import { OrchestrationMessageContext } from "./composerContext.ts";
import { MemoryTaskGrantCeilingField } from "./memory.ts";
import * as Schema from "effect/Schema";
import {
  CommandId,
  MessageId,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const OrchestrationV2ThreadLaunchWorkspaceStrategy = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("root"),
    branch: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("existing_worktree"),
    worktreePath: TrimmedNonEmptyString,
    branch: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("worktree"),
    baseRef: TrimmedNonEmptyString,
    branch: Schema.optional(TrimmedNonEmptyString),
    startFromOrigin: Schema.optional(Schema.Boolean),
  }),
]);
export type OrchestrationV2ThreadLaunchWorkspaceStrategy =
  typeof OrchestrationV2ThreadLaunchWorkspaceStrategy.Type;
// Server-owned input attached to a fresh launch's create command.
export const OrchestrationV2ThreadCreateInitialMessage = Schema.Struct({
  messageId: MessageId,
  legacyCommandId: Schema.optional(CommandId),
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  context: Schema.optional(OrchestrationMessageContext),
  titleSeed: Schema.optional(TrimmedNonEmptyString),
  scheduledTaskId: Schema.optional(ScheduledTaskId),
  senderThreadId: Schema.optional(ThreadId),
  workspaceStrategy: Schema.optional(OrchestrationV2ThreadLaunchWorkspaceStrategy),
  memoryGrantCeiling: MemoryTaskGrantCeilingField,
});
