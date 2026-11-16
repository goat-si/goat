import type { ComposerContextRecord, EnvironmentId } from "@goat/contracts";

import type {
  ComposerImageAttachment,
  PersistedComposerFileAttachment,
  PersistedComposerImageAttachment,
} from "../../composerDraftStore";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import {
  readAttachmentUpload,
  releaseAttachmentUpload,
  releasePersistedAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { compressImageForStash } from "../../lib/imageCompression";
import { resizeSnapShotSource } from "../../lib/snapShotSource";
import { partitionStashAttachments, usePromptStashStore } from "../../promptStashStore";
import {
  previewAnnotationContextRecord,
  reviewCommentContextRecord,
  terminalContextRecord,
} from "~/lib/composerContextRecords";
import { randomUUID } from "~/lib/utils";
import type { ComposerSendSnapshot } from "../ChatView.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** Re-encodes images for the stash: the composer takes 10MB per image, localStorage ~5MB in all. */
export async function encodeImagesForStash(images: ReadonlyArray<ComposerImageAttachment>) {
  const candidateAttachments: PersistedComposerImageAttachment[] = [];
  const oversizedImageNames: string[] = [];
  const unreadableImageNames: string[] = [];
  for (const image of images) {
    const result = await compressImageForStash(image.file);
    if (!result.ok) {
      (result.reason === "too-large" ? oversizedImageNames : unreadableImageNames).push(image.name);
      continue;
    }
    candidateAttachments.push({
      id: image.id,
      name: image.name,
      mimeType: result.image.mimeType,
      sizeBytes: result.image.sizeBytes,
      dataUrl: result.image.dataUrl,
      ...(image.source
        ? { source: resizeSnapShotSource(image.source, result.image.imageSize) }
        : {}),
    });
  }
  const { kept, droppedNames } = partitionStashAttachments(candidateAttachments);
  return {
    attachments: kept,
    droppedImageNames: [...oversizedImageNames, ...droppedNames],
    unreadableImageNames,
  };
}

/** Writes a failed send to the stash; images follow once encoded, as for a stashed prompt. */
function stashSendSnapshot(snapshot: ComposerSendSnapshot, environmentId: EnvironmentId) {
  const files: PersistedComposerFileAttachment[] = [];
  const unsavedFileNames: string[] = [];
  for (const file of snapshot.files) {
    const upload = readAttachmentUpload(file.id);
    if (upload?.status !== "ready" || upload.environmentId !== environmentId) {
      unsavedFileNames.push(file.name);
      continue;
    }
    files.push({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      attachmentId: upload.attachmentId,
      environmentId,
      ...(file.source ? { source: file.source } : {}),
    });
  }
  const records: ComposerContextRecord[] = [
    ...snapshot.threadContexts,
    ...snapshot.terminalContexts.map(terminalContextRecord),
    ...snapshot.reviewComments.map(reviewCommentContextRecord),
    ...snapshot.previewAnnotations.map((annotation) =>
      previewAnnotationContextRecord(annotation, {
        screenshotContextId: snapshot.images.some((image) => image.id === annotation.id)
          ? annotation.id
          : undefined,
      }),
    ),
  ];
  const stash = usePromptStashStore.getState();
  const entryId = randomUUID();
  const result = stash.stashEntry({
    id: entryId,
    createdAt: new Date().toISOString(),
    prompt: snapshot.messageText,
    attachments: [],
    ...(files.length > 0 ? { files } : {}),
    droppedImageNames: [],
    unreadableImageNames: unsavedFileNames,
    pendingImageCount: snapshot.images.length,
    ...(records.length > 0 ? { records } : {}),
  });
  if (!result.written) return result;
  for (const file of result.evicted?.files ?? []) {
    releasePersistedAttachmentUpload({
      id: file.id,
      environmentId: file.environmentId,
      attachmentId: file.attachmentId,
    });
  }
  for (const attachment of [...snapshot.images, ...snapshot.previewAnnotations]) {
    releaseAttachmentUpload(attachment.id);
  }
  if (snapshot.images.length > 0) {
    void encodeImagesForStash(snapshot.images)
      .catch(() => ({
        attachments: [],
        droppedImageNames: [],
        unreadableImageNames: snapshot.images.map((image) => image.name),
      }))
      .then((images) => {
        usePromptStashStore.getState().finalizeEntryImages(entryId, images);
      });
  }
  return result;
}

/**
 * A send that fails after a new draft was typed leaves the composer to that draft, so the failed
 * send (text, files, context and images) goes to the prompt stash and the toast says so.
 */
export function keepFailedSendInStash(input: {
  readonly snapshot: ComposerSendSnapshot;
  readonly environmentId: EnvironmentId;
  readonly interrupted: boolean;
}): void {
  const title = input.interrupted ? "Message may not have been sent" : "Message not sent";
  const { written, durable, evicted } = stashSendSnapshot(input.snapshot, input.environmentId);
  if (written) {
    const notes = [
      "Your new draft was kept, and the failed message is in the prompt stash.",
      durable ? null : "Browser storage is unavailable, so it stays only for this session.",
      evicted ? "The oldest stashed prompt was removed to make room." : null,
    ];
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: notes.filter((note) => note !== null).join(" "),
        data: { hideCopyButton: true },
      }),
    );
    return;
  }
  const failedText = input.snapshot.messageText;
  if (failedText.length === 0) return;
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description:
        "Your new draft was kept, and browser storage rejected the stash. Copy the failed message to send it again.",
      // The toast holds the only copy of the failed text, so it stays until dismissed.
      timeout: 0,
      data: { hideCopyButton: true },
      actionProps: {
        children: "Copy message",
        onClick: () => {
          void writeTextToClipboard(failedText, "failed message").catch(() => undefined);
        },
      },
    }),
  );
}
