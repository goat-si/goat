import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  MessageId,
  NodeId,
  NonNegativeInt,
  RunId,
  ThreadId,
  TurnItemId,
} from "./baseSchemas.ts";
import { ChatAttachmentId } from "./chatAttachment.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2TaskRole,
  OrchestrationV2TurnItemStatus,
} from "./orchestrationV2.ts";

export const OrchestratorMcpThreadTimelineItem = Schema.Struct({
  position: NonNegativeInt,
  visibility: Schema.Literals(["local", "inherited", "synthetic"]),
  sourceThreadId: ThreadId,
  itemId: TurnItemId,
  subagentId: Schema.optional(NodeId),
  role: Schema.optional(OrchestrationV2TaskRole),
  modelSelection: Schema.optional(ModelSelection),
  parentModelSelection: Schema.optional(ModelSelection),
  runId: Schema.NullOr(RunId),
  messageId: Schema.NullOr(MessageId),
  attachments: Schema.optional(
    Schema.Array(Schema.Struct({ id: ChatAttachmentId, name: Schema.String })),
  ),
  createdBy: Schema.NullOr(OrchestrationV2Actor),
  creationSource: Schema.NullOr(OrchestrationV2CreationSource),
  senderThreadId: Schema.optional(ThreadId),
  type: Schema.String,
  status: OrchestrationV2TurnItemStatus,
  title: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
  textTruncated: Schema.Boolean,
  nextTextOffset: Schema.optional(Schema.NullOr(NonNegativeInt)),
  updatedAt: IsoDateTime,
});
export type OrchestratorMcpThreadTimelineItem = typeof OrchestratorMcpThreadTimelineItem.Type;
