import { withClientRequestId } from "../keyedParameters.ts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import { McpAttachmentInput } from "./input.ts";
import {
  AttachmentCreateUploadUrlInput,
  AttachmentCreateUploadUrlResult,
  AttachmentDeleteInput,
  MessageId,
  RunId,
  ThreadId,
  OrchestrationV2RunStatus,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as DocumentText from "../../../provider/DocumentText.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerConfig.ServerConfig,
    ServerSecretStore.ServerSecretStore,
    FileSystem.FileSystem,
    Crypto.Crypto,
  ],
};
const AttachmentUploadTool = Tool.make(agentSurfaceRegistry["attachment.prepare_upload"].name, {
  ...shared,
  description: agentSurfaceRegistry["attachment.prepare_upload"].description,
  parameters: withClientRequestId(Schema.Struct({ upload: AttachmentCreateUploadUrlInput })),
  success: AttachmentCreateUploadUrlResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["attachment.prepare_upload"]));
const AttachmentPendingListTool = Tool.make(agentSurfaceRegistry["attachment.pending_list"].name, {
  ...shared,
  description: agentSurfaceRegistry["attachment.pending_list"].description,
  parameters: Tool.EmptyParams,
  success: Schema.Struct({
    uploads: Schema.Array(
      Schema.Struct({
        attachmentId: AttachmentCreateUploadUrlResult.fields.attachmentId,
        type: Schema.Literals(["image", "file"]),
        name: Schema.String,
        mimeType: Schema.String,
        sizeBytes: Schema.Number,
        expiresAt: AttachmentCreateUploadUrlResult.fields.expiresAt.annotate({
          description: "When the upload URL stops accepting bytes.",
        }),
        uploaded: Schema.Boolean,
      }),
    ),
  }),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["attachment.pending_list"]));
const AttachmentDiscardTool = Tool.make(agentSurfaceRegistry["attachment.discard"].name, {
  ...shared,
  description: agentSurfaceRegistry["attachment.discard"].description,
  parameters: AttachmentDeleteInput,
  success: Schema.Struct({}),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["attachment.discard"]));
const AttachmentSendTool = Tool.make(agentSurfaceRegistry["thread.send_attachments"].name, {
  ...shared,
  dependencies: [...shared.dependencies, DocumentText.DocumentText],
  description: agentSurfaceRegistry["thread.send_attachments"].description,
  parameters: withClientRequestId(
    Schema.Struct({
      threadId: Schema.optional(ThreadId),
      message: Schema.optional(Schema.String.check(Schema.isMaxLength(120000))),
      attachments: Schema.Array(McpAttachmentInput).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(8),
      ),
    }),
  ),
  success: Schema.Struct({
    threadId: ThreadId,
    messageId: MessageId,
    runId: RunId,
    status: OrchestrationV2RunStatus,
  }),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.send_attachments"]));
export const AttachmentToolkit = Toolkit.make(
  AttachmentUploadTool,
  AttachmentPendingListTool,
  AttachmentDiscardTool,
  AttachmentSendTool,
);
