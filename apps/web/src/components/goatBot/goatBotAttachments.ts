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

const attachmentOwners = new Map<
  string,
  { readonly attachment: GoatBotDraftAttachment; count: number }
>();
const previewOwners = new Map<string, number>();
const pendingRelease = new Map<string, GoatBotDraftAttachment>();

function uploadKeys(attachment: GoatBotDraftAttachment): ReadonlySet<string> {
  const keys = new Set<string>();
  const upload = readAttachmentUpload(attachment.id);
  if (upload?.status === "ready" || (upload?.status === "failed" && upload.attachmentId)) {
    keys.add(JSON.stringify([upload.environmentId, upload.attachmentId]));
  }
  if (upload && "previous" in upload && upload.previous)
    keys.add(JSON.stringify([upload.previous.environmentId, upload.previous.attachmentId]));
  if (
    attachment.type === "file" &&
    attachment.uploadEnvironmentId !== undefined &&
    attachment.uploadedAttachmentId !== undefined
  ) {
    keys.add(JSON.stringify([attachment.uploadEnvironmentId, attachment.uploadedAttachmentId]));
  }
  return keys;
}

function releaseUnownedUploads() {
  const ownedKeys = new Set(
    [...attachmentOwners.values()].flatMap((owner) => [...uploadKeys(owner.attachment)]),
  );
  for (const [id, attachment] of pendingRelease) {
    if ([...uploadKeys(attachment)].some((key) => ownedKeys.has(key))) continue;
    pendingRelease.delete(id);
    releaseDraftAttachments([attachment]);
  }
}

export function retainGoatBotAttachments(attachments: ReadonlyArray<GoatBotDraftAttachment>) {
  for (const attachment of attachments) {
    const owner = attachmentOwners.get(attachment.id);
    if (owner) owner.count += 1;
    else attachmentOwners.set(attachment.id, { attachment, count: 1 });
    pendingRelease.delete(attachment.id);
    if (attachment.type === "image")
      previewOwners.set(attachment.previewUrl, (previewOwners.get(attachment.previewUrl) ?? 0) + 1);
  }
}

export function releaseUnownedGoatBotAttachments(
  attachments: ReadonlyArray<GoatBotDraftAttachment>,
) {
  const revoked = new Set<string>();
  for (const attachment of attachments) {
    if (
      attachment.type === "image" &&
      !previewOwners.has(attachment.previewUrl) &&
      !revoked.has(attachment.previewUrl)
    ) {
      revoked.add(attachment.previewUrl);
      URL.revokeObjectURL(attachment.previewUrl);
    }
    if (!attachmentOwners.has(attachment.id)) pendingRelease.set(attachment.id, attachment);
  }
  releaseUnownedUploads();
}

/** Drops uploads and previews after their last draft or message owner releases them. */
export function releaseGoatBotAttachments(attachments: ReadonlyArray<GoatBotDraftAttachment>) {
  for (const attachment of attachments) {
    const owner = attachmentOwners.get(attachment.id);
    if (owner === undefined) continue;
    owner.count -= 1;
    if (attachment.type === "image") {
      const count = (previewOwners.get(attachment.previewUrl) ?? 1) - 1;
      if (count === 0) {
        previewOwners.delete(attachment.previewUrl);
        URL.revokeObjectURL(attachment.previewUrl);
      } else previewOwners.set(attachment.previewUrl, count);
    }
    if (owner.count === 0) {
      attachmentOwners.delete(attachment.id);
      pendingRelease.set(attachment.id, owner.attachment);
    }
  }
  releaseUnownedUploads();
}
