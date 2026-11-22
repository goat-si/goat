import { readSnapshotClipboardWrapper } from "../snapshotClipboardFingerprint";
import { toKindScopedComposerContextId } from "@goat/shared/composerContextReferences";
import { collectInlineContextIds } from "../../lib/composerContextReferences";
import {
  type EnvironmentId,
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
} from "@goat/contracts";
import {
  clampFileAttachmentUploadBytes,
  fileAttachmentTooLargeMessage,
} from "@goat/client-runtime/state/attachments";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import { isHeicImageFile } from "../../lib/imageCompression";
import { isVideoAttachment, videoMimeType } from "../../types";
import { isSvgAttachment } from "@goat/shared/image";
import { isWorkspaceImagePreviewPath } from "@goat/shared/mediaPreview";

export function composerImageDedupKey(image: ComposerImageAttachment): string {
  // Hydrated images get fresh lastModified values, so exclude it from dedupe.
  return `${image.mimeType}\u0000${image.sizeBytes}\u0000${image.name}`;
}

export function composerFileDedupKey(
  file: Pick<ComposerFileAttachment, "mimeType" | "sizeBytes" | "name">,
): string {
  return `${file.mimeType}\u0000${file.sizeBytes}\u0000${file.name}`;
}

export function composerFileMatchesReattachMarker(
  marker: Pick<ComposerFileAttachment, "mimeType" | "sizeBytes" | "name">,
  file: Pick<ComposerFileAttachment, "mimeType" | "sizeBytes" | "name">,
): boolean {
  if (marker.name !== file.name || marker.sizeBytes !== file.sizeBytes) return false;
  if (marker.mimeType === file.mimeType) return true;
  const normalizedMarkerMimeType = composerFileAttachmentMimeType({
    name: marker.name,
    type: marker.mimeType,
  });
  if (
    normalizedMarkerMimeType === "image/x-adobe-dng" &&
    normalizedMarkerMimeType ===
      composerFileAttachmentMimeType({ name: file.name, type: file.mimeType })
  ) {
    return true;
  }
  const markerMimeType = marker.mimeType.toLowerCase();
  return (
    (markerMimeType === "" || markerMimeType === "application/octet-stream") &&
    videoMimeType(marker) !== null &&
    videoMimeType(file) !== null
  );
}

type ComposerAttachmentFileKind = "image" | "file" | "unsupported-image";

interface FileAttachmentCapabilityState {
  readonly attachmentUploadsCapabilityKnown: boolean;
  readonly supportsAttachmentUploads: boolean;
  readonly maxFileAttachmentBytes: number | null;
}

const IMAGE_MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/**
 * Some sources (drags from other apps, files piped through a shell) hand over a
 * `File` with an empty or generic MIME type.
 */
function inferImageMimeTypeFromName(name: string): string | null {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) {
    return null;
  }
  return IMAGE_MIME_TYPE_BY_EXTENSION[name.slice(dotIndex + 1).toLowerCase()] ?? null;
}

function inferImageMimeTypeForUnknownFile(file: Pick<File, "name" | "type">): string | null {
  const mimeType = file.type.toLowerCase();
  if (mimeType !== "" && mimeType !== "application/octet-stream") {
    return null;
  }
  return inferImageMimeTypeFromName(file.name);
}

export function normalizeComposerImageFileMimeType(file: File): File {
  const inferredMimeType = inferImageMimeTypeForUnknownFile(file);
  if (!inferredMimeType) {
    return file;
  }
  return new File([file], file.name, {
    type: inferredMimeType,
    lastModified: file.lastModified,
  });
}

function isDngFile(file: Pick<File, "name" | "type">): boolean {
  const mimeType = file.type.split(";", 1)[0]?.trim().toLowerCase();
  return (
    file.name.toLowerCase().endsWith(".dng") ||
    mimeType === "image/dng" ||
    mimeType === "image/x-dng" ||
    mimeType === "image/x-adobe-dng"
  );
}

export function composerFileAttachmentMimeType(file: Pick<File, "name" | "type">): string {
  // Downstream image detection uses MIME, even for attachments staged as files.
  if (isDngFile(file)) return "image/x-adobe-dng";
  if (isSvgAttachment({ name: file.name, mimeType: file.type })) return "image/svg+xml";
  return (
    videoMimeType({ name: file.name, mimeType: file.type }) ??
    (file.type || "application/octet-stream")
  );
}

export function classifyComposerAttachmentFile(
  file: Pick<File, "name" | "type">,
): ComposerAttachmentFileKind {
  if (isSvgAttachment({ name: file.name, mimeType: file.type })) return "file";
  if (isDngFile(file)) return "file";
  if (isHeicImageFile(file)) {
    return "image";
  }
  if (inferImageMimeTypeForUnknownFile(file)) {
    return "image";
  }
  if (!file.type.toLowerCase().startsWith("image/")) {
    return "file";
  }
  if (isProviderSendTurnSupportedImageMimeType(file.type)) return "image";
  // These can be previewed as files, but providers must not receive them as images.
  return isWorkspaceImagePreviewPath(file.name) ? "file" : "unsupported-image";
}

export function isPreviewableComposerVideo(
  file: ComposerFileAttachment,
  environmentId: EnvironmentId,
): boolean {
  return (
    isVideoAttachment(file) &&
    (file.file !== null ||
      (file.uploadedAttachmentId !== undefined && file.uploadEnvironmentId === environmentId))
  );
}

export function composerOtherFilesForPresentation(
  files: ReadonlyArray<ComposerFileAttachment>,
  environmentId: EnvironmentId,
  inlineFileIds: ReadonlySet<string>,
): ComposerFileAttachment[] {
  return files.filter(
    (file) => !isPreviewableComposerVideo(file, environmentId) && !inlineFileIds.has(file.id),
  );
}

export function fileAttachmentStagingLimit(input: FileAttachmentCapabilityState): number | null {
  if (!input.attachmentUploadsCapabilityKnown) {
    return PROVIDER_SEND_TURN_MAX_FILE_BYTES;
  }
  if (!input.supportsAttachmentUploads || input.maxFileAttachmentBytes === null) {
    return null;
  }
  return clampFileAttachmentUploadBytes(input.maxFileAttachmentBytes);
}

export function fileAttachmentCapabilityBlockReason(
  input: FileAttachmentCapabilityState & {
    readonly files: ReadonlyArray<{ readonly name: string; readonly sizeBytes: number }>;
  },
): string | null {
  if (input.files.length === 0) {
    return null;
  }
  if (!input.attachmentUploadsCapabilityKnown) {
    return "Waiting for the server before file attachments can send";
  }
  const maxFileAttachmentBytes = fileAttachmentStagingLimit(input);
  if (maxFileAttachmentBytes === null) {
    return "This server does not accept file attachments right now. Remove the files to send.";
  }
  const oversizedFile = input.files.find((file) => file.sizeBytes > maxFileAttachmentBytes);
  if (oversizedFile) {
    return fileAttachmentTooLargeMessage(oversizedFile.name, maxFileAttachmentBytes);
  }
  return null;
}

/** Release only unpersisted uploads; hydrated files still need their server copies. */
export function attachmentsToReleaseOnUploadCapabilityLoss(
  attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>,
): Array<ComposerImageAttachment | ComposerFileAttachment> {
  return attachments.filter(
    (attachment) => !(attachment.type === "file" && attachment.uploadedAttachmentId !== undefined),
  );
}

function isOnlyFileNames(text: string, files: ReadonlyArray<File>): boolean {
  const names = new Set(files.map((file) => file.name));
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .every((line) => names.has(line));
}

export function clipboardHtmlImageContent(html: string): "only-image" | "image-and-text" | "none" {
  if (!html) return "none";
  if (readSnapshotClipboardWrapper(html)) return "only-image";
  const body = new DOMParser().parseFromString(html, "text/html").body;
  if (!body.querySelector("img")) return "none";
  return (body.textContent ?? "").trim().length === 0 ? "only-image" : "image-and-text";
}

function isPastedImageFile(file: File): boolean {
  const classification = classifyComposerAttachmentFile(file);
  return classification === "image" || classification === "unsupported-image";
}

export function imagesToAttachBesidePastedText(input: {
  readonly files: ReadonlyArray<File>;
  readonly plainText: string;
  readonly bypassAutoAttachment?: boolean;
  readonly htmlHasImageAndText: boolean;
}): File[] {
  if (input.bypassAutoAttachment || !input.plainText || !input.htmlHasImageAndText) return [];
  return input.files.filter(isPastedImageFile);
}

export function shouldHandleComposerAttachmentPaste(input: {
  readonly files: ReadonlyArray<File>;
  readonly plainText: string;
  readonly bypassAutoAttachment?: boolean;
  readonly htmlIsOnlyImage?: boolean;
}): boolean {
  // Paste as Text keeps the text even when the source also put an image of it on the clipboard.
  if (input.bypassAutoAttachment && input.plainText.length > 0) return false;
  if (
    input.files.some(
      (file) => isDngFile(file) || isSvgAttachment({ name: file.name, mimeType: file.type }),
    )
  ) {
    return true;
  }
  const hasImage = input.files.some((file) => {
    const classification = classifyComposerAttachmentFile(file);
    return classification === "image" || classification === "unsupported-image";
  });
  if (input.plainText.length === 0) {
    return hasImage || input.files.some((file) => classifyComposerAttachmentFile(file) === "file");
  }
  // Rich text sources (Word, Pages) add a picture of the text. Copy Image adds the image URL as
  // text beside an <img>, and a Finder copy adds the file names.
  return (
    hasImage && (input.htmlIsOnlyImage === true || isOnlyFileNames(input.plainText, input.files))
  );
}

export function composerInlineFileIds(
  questionAttachmentTarget: unknown,
  prompt: string,
  composerFiles: ReadonlyArray<ComposerFileAttachment>,
) {
  if (questionAttachmentTarget) return new Set<string>();
  const contextIds = new Set(collectInlineContextIds(prompt));
  return new Set(
    composerFiles
      .filter((file) => contextIds.has(toKindScopedComposerContextId("file", file.id)))
      .map((file) => file.id),
  );
}
