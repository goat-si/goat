import {
  ATTACHMENT_UPLOAD_URL_TTL_MS,
  type AttachmentCreateUploadUrlInput,
  type ChatAttachment,
  MessageId,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as FileSystem from "effect/FileSystem";
import { attachmentPathCandidatesById } from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Upload from "../../../assets/AttachmentUpload.ts";
import * as Claims from "../../../orchestration-v2/AttachmentClaims.ts";
import * as ThreadMessageIntake from "../../../orchestration-v2/ThreadMessageIntake.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { newCommandId, readThread, unavailable } from "../../threadAccess.ts";
import { AttachmentToolkit } from "./tools.ts";

export function resolveAttachmentReferences(
  requested: ReadonlyArray<ChatAttachment>,
  stored: ReadonlyArray<ChatAttachment>,
) {
  const owned = new Map(stored.map((attachment) => [attachment.id, attachment]));
  return Effect.forEach(requested, (attachment) => {
    const canonical = Claims.attachmentIsPendingUpload(attachment)
      ? attachment
      : owned.get(attachment.id);
    return canonical === undefined
      ? Effect.fail(
          new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "Attachments must be pending uploads or already belong to the target thread.",
          }),
        )
      : Effect.succeed(canonical);
  });
}

/**
 * The sweep counts its 24 hours from when the upload finishes, which can be up
 * to the upload URL's lifetime after issue.
 */
const UPLOAD_OWNER_TTL_MS = 24 * 60 * 60 * 1000 + ATTACHMENT_UPLOAD_URL_TTL_MS;

const uploadOwner = McpInvocationContext.McpInvocationContext.pipe(
  Effect.map((scope) => scope.thread?.threadId ?? scope.requestNamespace),
);

/**
 * Whether a pending upload's bytes arrived; claiming it for a thread moves the file away. A lookup
 * that fails is an error, never "not uploaded", which would invite a second upload.
 */
const uploaded = Effect.fn("mcp.attachment.uploaded")(function* (attachmentId: string) {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const candidates = attachmentPathCandidatesById({
    attachmentsDir: config.attachmentsDir,
    attachmentId,
  });
  for (const candidate of candidates) {
    if (yield* fs.exists(candidate).pipe(Effect.mapError(unavailable))) return true;
  }
  return false;
});

const PendingUpload = Schema.Struct({
  attachmentId: Schema.String,
  type: Schema.Literals(["image", "file"]),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  expiresAt: Schema.Number,
});
const decodePendingUploads = Schema.decodeUnknownEffect(Schema.Array(PendingUpload));

/**
 * Who prepared each pending upload. It is stored, not kept in memory: a replayed prepare hands
 * back a URL that still accepts bytes after a restart, and its caller must still own the upload.
 */
const pendingUploadStore = (sql: SqlClient.SqlClient) => {
  const prune = Effect.flatMap(
    Clock.currentTimeMillis,
    (now) => sql`DELETE FROM mcp_pending_uploads WHERE issued_at < ${now - UPLOAD_OWNER_TTL_MS}`,
  );
  return {
    record: Effect.fn("mcp.attachment.recordPending")(function* (
      attachmentId: string,
      owner: string,
      upload: AttachmentCreateUploadUrlInput,
      expiresAt: number,
    ) {
      yield* prune;
      yield* sql`INSERT INTO mcp_pending_uploads
        (attachment_id, owner, type, name, mime_type, size_bytes, expires_at, issued_at)
        VALUES (${attachmentId}, ${owner}, ${upload.type ?? "image"}, ${upload.name},
          ${upload.mimeType}, ${upload.sizeBytes}, ${expiresAt}, ${yield* Clock.currentTimeMillis})`;
    }),
    ownedBy: Effect.fn("mcp.attachment.pendingOwnedBy")(function* (owner: string) {
      yield* prune;
      return yield* decodePendingUploads(
        yield* sql`SELECT attachment_id AS "attachmentId", type, name, mime_type AS "mimeType",
          size_bytes AS "sizeBytes", expires_at AS "expiresAt"
          FROM mcp_pending_uploads WHERE owner = ${owner} ORDER BY issued_at, attachment_id`,
      );
    }),
    ownerOf: Effect.fn("mcp.attachment.pendingOwner")(function* (attachmentId: string) {
      const rows = yield* sql<{ readonly owner: string }>`
        SELECT owner FROM mcp_pending_uploads WHERE attachment_id = ${attachmentId}`;
      return rows[0]?.owner;
    }),
    remove: Effect.fn("mcp.attachment.removePending")(function* (
      attachmentIds: ReadonlyArray<string>,
    ) {
      for (const attachmentId of attachmentIds)
        yield* sql`DELETE FROM mcp_pending_uploads WHERE attachment_id = ${attachmentId}`;
    }),
  };
};

export const layer = McpToolAccess.toLayer(
  AttachmentToolkit,
  Effect.gen(function* () {
    // Without a database no upload can be owned, so these calls refuse, as keyed writes do.
    const database = yield* Effect.serviceOption(SqlClient.SqlClient);
    const pendingUploads = Effect.mapError(
      Effect.map(Effect.fromOption(database), pendingUploadStore),
      unavailable,
    );
    return {
      goat_attachment_prepare_upload: McpToolAccess.destructive(
        McpToolAccess.writes((input) =>
          Effect.gen(function* () {
            const result = yield* Upload.issueAttachmentUploadUrl(input.upload).pipe(
              Effect.mapError(unavailable),
            );
            yield* (yield* pendingUploads)
              .record(result.attachmentId, yield* uploadOwner, input.upload, result.expiresAt)
              .pipe(Effect.mapError(unavailable));
            return result;
          }),
        ),
      ),
      goat_attachment_pending_list: McpToolAccess.reads(() =>
        Effect.gen(function* () {
          const owned = yield* (yield* pendingUploads)
            .ownedBy(yield* uploadOwner)
            .pipe(Effect.mapError(unavailable));
          return {
            uploads: yield* Effect.forEach(owned, (upload) =>
              Effect.map(uploaded(upload.attachmentId), (present) => ({
                ...upload,
                uploaded: present,
              })),
            ),
          };
        }),
      ),
      goat_attachment_discard: McpToolAccess.destructive(
        McpToolAccess.writes((input) =>
          Effect.gen(function* () {
            const owner = yield* (yield* pendingUploads)
              .ownerOf(input.attachmentId)
              .pipe(Effect.mapError(unavailable));
            if (owner !== (yield* uploadOwner)) {
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message: "Only the caller that prepared a pending upload can discard it.",
              });
            }
            // Ownership stays until the file is gone, so a failed removal can be retried.
            yield* Upload.discardPendingAttachment(input.attachmentId).pipe(
              Effect.mapError(
                () =>
                  new OrchestratorMcpFailure({
                    code: "orchestration_error",
                    reason: "attachment_remove_failed",
                    message: "The pending upload could not be removed. Discard it again.",
                  }),
              ),
            );
            yield* (yield* pendingUploads)
              .remove([input.attachmentId])
              .pipe(Effect.mapError(unavailable));
            return {};
          }),
        ),
      ),
      goat_thread_send_attachments: McpToolAccess.destructive(
        McpToolAccess.writesThreads(
          (input) => [input.threadId],
          (input) =>
            Effect.gen(function* () {
              const { caller, projection } = yield* readThread(input.threadId, ["messages"]);
              yield* McpToolAccess.admit(input);
              if (projection.thread.archivedAt !== null)
                return yield* new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: "Unarchive the target thread before sending attachments.",
                });
              const attachments = yield* resolveAttachmentReferences(
                input.attachments,
                projection.messages.flatMap((message) => message.attachments),
              );
              const commandId = yield* newCommandId();
              const messageId = MessageId.make(commandId);
              const result = yield* ThreadMessageIntake.sendToThread({
                projectId: projection.thread.projectId,
                threadId: projection.thread.id,
                commandId,
                messageId,
                ...(caller === undefined ? {} : { senderThreadId: caller.id }),
                text: input.message ?? "",
                attachments,
                mode: "steer_when_ready",
                createdBy: "agent",
                creationSource: "mcp",
              }).pipe(
                Effect.mapError((error) =>
                  error._tag === "AttachmentClaimError"
                    ? new OrchestratorMcpFailure({
                        code: "orchestration_error",
                        message: error.message,
                      })
                    : unavailable(),
                ),
              );
              // A claimed upload belongs to the thread now, so it is pending for no one. The message
              // is already sent; a row left behind only lists an upload that is gone.
              yield* pendingUploads.pipe(
                Effect.flatMap((store) =>
                  store.remove(input.attachments.map((attachment) => attachment.id)),
                ),
                Effect.ignoreCause({ log: true }),
              );
              return {
                threadId: projection.thread.id,
                messageId,
                runId: result.run.id,
                status: result.run.status,
              };
            }),
          { admission: "handler" },
        ),
      ),
    };
  }),
);
