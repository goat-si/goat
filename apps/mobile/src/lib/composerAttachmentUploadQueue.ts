import { EnvironmentId, type ServerConfig } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { createAttachmentUploadRegistry } from "@goat/client-runtime/state/attachmentUploadRegistry";
import { clampFileAttachmentUploadBytes } from "@goat/client-runtime/state/attachments";

import { parseLegacyNewTaskDraftKey } from "../state/new-task-draft-key";
import type { DraftComposerAttachment } from "./composerImages";

export interface ComposerAttachmentUploadRequest {
  readonly environmentId: EnvironmentId;
  readonly attachment: DraftComposerAttachment;
}

export type ComposerAttachmentUploadState =
  | { readonly status: "uploading"; readonly progress: number }
  | { readonly status: "ready" }
  | { readonly status: "failed"; readonly reason: string };

export function composerAttachmentUploadKey(
  environmentId: EnvironmentId,
  attachmentId: string,
): string {
  return JSON.stringify([environmentId, attachmentId]);
}

/** Environment and thread ids may both contain colons, so a thread draft key resolves to the longest known environment it starts with. */
export function composerDraftEnvironmentId(
  draftKey: string,
  environmentIds: Iterable<EnvironmentId>,
  queuedMessages: ReadonlyArray<{
    readonly messageId: string;
    readonly environmentId: EnvironmentId;
  }>,
  draft?: { readonly project?: { readonly environmentId: EnvironmentId } },
): EnvironmentId | null {
  if (draftKey.startsWith("pending-task:")) {
    return (
      queuedMessages.find((message) => `pending-task:${message.messageId}` === draftKey)
        ?.environmentId ?? null
    );
  }
  if (draftKey.startsWith("new-task:")) {
    if (draft?.project) {
      return draft.project.environmentId;
    }
    const legacy = parseLegacyNewTaskDraftKey(draftKey);
    return legacy === null ? null : EnvironmentId.make(legacy.environmentId);
  }
  let match: EnvironmentId | null = null;
  for (const environmentId of environmentIds) {
    if (
      draftKey.startsWith(`${environmentId}:`) &&
      (match === null || environmentId.length > match.length)
    ) {
      match = environmentId;
    }
  }
  return match;
}

type UploadServerConfig = {
  readonly environment: {
    readonly capabilities: Pick<
      ServerConfig["environment"]["capabilities"],
      "attachmentUploads" | "fileAttachments"
    >;
  };
};

export function canUploadComposerAttachment(
  attachment: DraftComposerAttachment,
  config: UploadServerConfig | null | undefined,
): boolean {
  const capabilities = config?.environment.capabilities;
  return (
    capabilities?.attachmentUploads === true &&
    (attachment.type === "image" ||
      (capabilities.fileAttachments !== undefined &&
        attachment.sizeBytes <=
          clampFileAttachmentUploadBytes(capabilities.fileAttachments.maxUploadBytes)))
  );
}

export function composerAttachmentUploadBlockReason(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly connected: boolean;
  readonly serverConfig: UploadServerConfig | null;
  readonly states: Readonly<Record<string, ComposerAttachmentUploadState>>;
}): string | null {
  if (!input.connected) return null;
  for (const attachment of input.attachments) {
    if (!canUploadComposerAttachment(attachment, input.serverConfig)) continue;
    const state = input.states[composerAttachmentUploadKey(input.environmentId, attachment.id)];
    if (state?.status === "failed") return "Retry or remove the failed attachment";
  }
  return null;
}

export function composerAttachmentsStillUploading(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly serverConfig: UploadServerConfig | null;
  readonly states: Readonly<Record<string, ComposerAttachmentUploadState>>;
}): boolean {
  return input.attachments.some((attachment) => {
    if (!canUploadComposerAttachment(attachment, input.serverConfig)) return false;
    const state = input.states[composerAttachmentUploadKey(input.environmentId, attachment.id)];
    return state?.status !== "ready" && state?.status !== "failed";
  });
}

/** Changes when an upload starts or settles, not on its progress ticks. */
export function uploadingComposerAttachmentKeys(
  states: Readonly<Record<string, ComposerAttachmentUploadState>>,
): string {
  return Object.keys(states)
    .filter((key) => states[key]?.status === "uploading")
    .sort()
    .join("\n");
}

/** A queued message waits for the worker's upload instead of starting a second one. */
export function queuedAttachmentsStillUploading(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly states: Readonly<Record<string, ComposerAttachmentUploadState>>;
}): boolean {
  return input.attachments.some(
    (attachment) =>
      attachment.uploadedAttachmentId === undefined &&
      input.states[composerAttachmentUploadKey(input.environmentId, attachment.id)]?.status ===
        "uploading",
  );
}

export function createComposerAttachmentUploadQueue(options: {
  readonly upload: (
    request: ComposerAttachmentUploadRequest,
    signal: AbortSignal,
    onProgress: (progress: number) => void,
  ) => Promise<string>;
  readonly onUploaded?: (
    request: ComposerAttachmentUploadRequest,
    uploadedId: string,
  ) => Effect.Effect<void, ComposerAttachmentUploadError>;
  readonly onChange: (states: Readonly<Record<string, ComposerAttachmentUploadState>>) => void;
}) {
  const registry = createAttachmentUploadRegistry({
    ...options,
    key: (request: ComposerAttachmentUploadRequest) =>
      composerAttachmentUploadKey(request.environmentId, request.attachment.id),
    error: uploadError,
  });
  return {
    ...registry,
    retry: (environmentId: EnvironmentId, attachmentId: string) =>
      registry.retry(composerAttachmentUploadKey(environmentId, attachmentId)),
  };
}

export function uploadError(cause: unknown): ComposerAttachmentUploadError {
  if (isComposerAttachmentUploadError(cause)) return cause;
  return new ComposerAttachmentUploadError({
    message: cause instanceof Error ? cause.message : "Upload failed. Tap to retry.",
    cause,
  });
}

export class ComposerAttachmentUploadError extends Schema.TaggedError<ComposerAttachmentUploadError>()(
  "ComposerAttachmentUploadError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

const isComposerAttachmentUploadError = Schema.is(ComposerAttachmentUploadError);
