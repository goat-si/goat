import {
  type ChatAttachment,
  type EnvironmentId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@goat/contracts";
import {
  clampFileAttachmentUploadBytes,
  fileAttachmentTooLargeMessage,
} from "@goat/client-runtime/state/attachments";

import type { ComposerFileAttachment, ComposerImageAttachment } from "~/composerDraftStore";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  readAttachmentUpload,
  releaseDraftAttachments,
  retryAttachmentUpload,
  startAttachmentUpload,
} from "~/lib/attachmentUploadQueue";
import { prepareImageForAttachment } from "~/lib/imageCompression";
import { randomUUID } from "~/lib/utils";
import {
  classifyComposerAttachmentFile,
  composerFileAttachmentMimeType,
  normalizeComposerImageFileMimeType,
} from "../chat/composerAttachmentFiles";

export type GoatBotDraftAttachment = ComposerImageAttachment | ComposerFileAttachment;

/** What the home server takes with a GOAT Bot message; null when it takes no files. */
export interface GoatBotAttachmentSupport {
  /** The largest non-image file; null when only images can go. */
  readonly maxUploadBytes: number | null;
}

/**
 * Turns picked or pasted files into draft attachments the way the thread composer does:
 * images are compressed to the provider limit, other files are checked against the server's.
 */
export async function stageGoatBotFiles(
  files: ReadonlyArray<File>,
  input: { readonly existingCount: number; readonly support: GoatBotAttachmentSupport },
): Promise<{
  readonly staged: ReadonlyArray<GoatBotDraftAttachment>;
  readonly error: string | null;
}> {
  const staged: GoatBotDraftAttachment[] = [];
  let error: string | null = null;
  const maxFileBytes =
    input.support.maxUploadBytes === null
      ? null
      : clampFileAttachmentUploadBytes(input.support.maxUploadBytes);
  for (const picked of files) {
    if (input.existingCount + staged.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`;
      break;
    }
    const kind = classifyComposerAttachmentFile(picked);
    if (kind === "unsupported-image") {
      error = `'${picked.name}' is not a supported image type. Attach GIF, HEIC, HEIF, JPEG, PNG, or WebP images.`;
      continue;
    }
    if (kind === "image") {
      const result = await prepareImageForAttachment(
        normalizeComposerImageFileMimeType(picked),
        PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
      ).catch(() => ({ ok: false, reason: "unreadable" }) as const);
      if (!result.ok) {
        error =
          result.reason === "unreadable"
            ? `'${picked.name}' could not be read as an image.`
            : `'${picked.name}' is too large to attach, even after compression.`;
        continue;
      }
      staged.push({
        type: "image",
        id: randomUUID(),
        name: result.file.name || "image",
        mimeType: result.file.type,
        sizeBytes: result.file.size,
        previewUrl: URL.createObjectURL(result.file),
        file: result.file,
      });
      continue;
    }
    if (maxFileBytes === null) {
      error = "This server takes only images with GOAT Bot messages.";
      continue;
    }
    if (picked.size <= 0) {
      error = `'${picked.name}' is empty or could not be read.`;
      continue;
    }
    if (picked.size > maxFileBytes) {
      error = fileAttachmentTooLargeMessage(picked.name, maxFileBytes);
      continue;
    }
    const mimeType = composerFileAttachmentMimeType(picked);
    const file =
      picked.type === mimeType
        ? picked
        : new File([picked], picked.name, { type: mimeType, lastModified: picked.lastModified });
    staged.push({
      type: "file",
      id: randomUUID(),
      name: file.name || "file",
      mimeType,
      sizeBytes: file.size,
      file,
    });
  }
  return { staged, error };
}

/**
 * Uploads a message's attachments and returns the references ingest names. The upload queue
 * keys uploads by attachment id, so a retry of the same message reuses finished uploads.
 */
export async function uploadGoatBotAttachments(
  environmentId: EnvironmentId,
  attachments: ReadonlyArray<GoatBotDraftAttachment>,
): Promise<ReadonlyArray<ChatAttachment>> {
  if (attachments.length === 0) return [];
  for (const attachment of attachments) {
    // A failed upload stays failed until retried, so retrying the message retries it.
    if (readAttachmentUpload(attachment.id)?.status === "failed") {
      retryAttachmentUpload({ environmentId, image: attachment });
    } else {
      startAttachmentUpload({ environmentId, image: attachment });
    }
  }
  await awaitAttachmentUploads(attachments.map((attachment) => attachment.id));
  const uploaded = getUploadedAttachments({ environmentId, images: attachments });
  if (uploaded === null) throw new Error("An attachment didn't finish uploading.");
  return uploaded;
}

/** Drops a draft's uploads and previews once they are sent or removed. */
export function releaseGoatBotAttachments(attachments: ReadonlyArray<GoatBotDraftAttachment>) {
  releaseDraftAttachments(attachments);
  for (const attachment of attachments) {
    if (attachment.type === "image") URL.revokeObjectURL(attachment.previewUrl);
  }
}
