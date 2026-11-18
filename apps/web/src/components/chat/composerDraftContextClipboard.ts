import type { ComposerContextRecord, EnvironmentId, ThreadId } from "@goat/contracts";
import { encodeComposerContextFragment } from "@goat/shared/composerContextClipboard";
import { toKindScopedComposerContextId } from "@goat/shared/composerContextReferences";
import type { composerContextRecordsFromDraft } from "../composerContextPresentation";
import { rememberCopiedComposerAttachments } from "~/lib/copiedComposerAttachments";
import {
  attachmentContextRecord,
  previewAnnotationContextId,
  previewAnnotationContextRecord,
  reviewCommentContextId,
  reviewCommentContextRecord,
  terminalContextRecord,
  terminalContextReference,
  uploadedAttachmentContextRecord,
} from "~/lib/composerContextRecords";

export function buildDraftContextClipboardFragment(
  contextIds: ReadonlyArray<string>,
  environmentId: EnvironmentId,
  threadId: ThreadId | undefined,
  draft: Required<Parameters<typeof composerContextRecordsFromDraft>[0]>,
): string | null {
  const {
    terminalContexts,
    threadContexts,
    previewTabs,
    reviewComments,
    previewAnnotations,
    images,
    files,
    uploadsByImageId,
  } = draft;
  const wanted = new Set(contextIds);
  const copiedFiles = new Map<string, File>();
  for (const annotation of previewAnnotations) {
    if (
      wanted.has(previewAnnotationContextId(annotation.id)) &&
      images.some((image) => image.id === annotation.id)
    ) {
      wanted.add(toKindScopedComposerContextId("image", annotation.id));
    }
  }
  const records: ComposerContextRecord[] = [
    ...terminalContexts
      .filter((c) => wanted.has(terminalContextReference(c).contextId))
      .map(terminalContextRecord),
    ...threadContexts.filter((record) => wanted.has(record.contextId)),
    ...previewTabs.filter((record) => wanted.has(record.contextId)),
    ...reviewComments
      .filter((c) => wanted.has(reviewCommentContextId(c.id)))
      .map(reviewCommentContextRecord),
    ...previewAnnotations
      .filter((a) => wanted.has(previewAnnotationContextId(a.id)))
      .map((annotation) =>
        previewAnnotationContextRecord(annotation, {
          screenshotContextId: images.some((image) => image.id === annotation.id)
            ? annotation.id
            : undefined,
        }),
      ),
    ...[...images, ...files]
      .filter((attachment) =>
        wanted.has(toKindScopedComposerContextId(attachment.type, attachment.id)),
      )
      .flatMap((attachment) => {
        const record =
          uploadedAttachmentContextRecord(attachment, uploadsByImageId[attachment.id]) ??
          (attachment.file
            ? attachmentContextRecord({ attachment, attachmentId: attachment.id })
            : null);
        if (!record) return [];
        if (attachment.file) copiedFiles.set(record.attachmentId, attachment.file);
        return [record];
      }),
  ];
  if (records.length === 0) return null;
  const fragment = encodeComposerContextFragment({
    version: 1,
    source: { environmentId, ...(threadId ? { threadId } : {}) },
    records,
  });
  if (fragment) rememberCopiedComposerAttachments(environmentId, copiedFiles);
  return fragment;
}
