import { resolveQueuedEditExit } from "@goat/client-runtime/queued-run-edit";
import {
  ChatFileAttachment,
  ChatImageAttachment,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ChatAttachment,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import {
  composerDraftHasUserContent,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
} from "../../composerDraftStore";

const isImageAttachment = Schema.is(ChatImageAttachment);
const isFileAttachment = Schema.is(ChatFileAttachment);

export async function recoverQueuedMessageEdit(input: {
  readonly editTarget: ComposerThreadTarget;
  readonly threadTarget: ComposerThreadTarget;
  readonly originalText: string;
  readonly removedExistingAttachment?: boolean;
  readonly existingAttachments?: ReadonlyArray<ChatAttachment>;
  readonly loadAttachment?: (attachment: ChatAttachment) => Promise<File>;
}): Promise<"kept" | "discarded" | "clean" | "failed"> {
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(input.editTarget);
  const recovery = resolveQueuedEditExit({
    editChanged:
      input.removedExistingAttachment === true ||
      (draft !== null &&
        (draft.prompt !== input.originalText || draft.images.length > 0 || draft.files.length > 0)),
    threadDraftEmpty: !composerDraftHasUserContent(store.getComposerDraft(input.threadTarget)),
  });
  if (recovery === "kept") {
    const existing = input.existingAttachments ?? [];
    if (!composerDraftHasUserContent(draft) && existing.length === 0) {
      store.clearComposerContent(input.editTarget);
      return "discarded";
    }
    let files: File[];
    try {
      const load = input.loadAttachment;
      if (existing.length > 0 && !load) return "failed";
      files = load ? await Promise.all(existing.map(load)) : [];
    } catch {
      return "failed";
    }
    if (
      useComposerDraftStore.getState().getComposerDraft(input.editTarget) !== draft ||
      composerDraftHasUserContent(store.getComposerDraft(input.threadTarget)) ||
      (draft?.images.length ?? 0) + (draft?.files.length ?? 0) + existing.length >
        PROVIDER_SEND_TURN_MAX_ATTACHMENTS ||
      new Set(existing.map((attachment) => attachment.id)).size !== existing.length ||
      existing.some((attachment) =>
        [...(draft?.images ?? []), ...(draft?.files ?? [])].some(
          (item) => item.id === attachment.id,
        ),
      ) ||
      existing.some((attachment) => !isImageAttachment(attachment) && !isFileAttachment(attachment))
    )
      return "failed";
    const images: ComposerImageAttachment[] = [];
    const attachments: ComposerFileAttachment[] = [];
    for (const [index, attachment] of existing.entries()) {
      const file = files[index];
      if (!file) return "failed";
      if (isImageAttachment(attachment)) {
        images.push({ ...attachment, file, previewUrl: URL.createObjectURL(file) });
      } else if (isFileAttachment(attachment)) {
        attachments.push({ ...attachment, file });
      }
    }
    store.addImages(input.editTarget, images, { allowDuplicates: true });
    store.addFiles(input.editTarget, attachments, { allowDuplicates: true });
    store.moveComposerPromptAndImages(input.editTarget, input.threadTarget);
    if (draft) {
      store.setTerminalContexts(input.threadTarget, draft.terminalContexts);
      store.setReviewComments(input.threadTarget, draft.reviewComments);
      store.setPreviewAnnotations(input.threadTarget, draft.previewAnnotations);
      store.setThreadContexts(input.threadTarget, draft.threadContexts);
      store.setPreviewTabs(input.threadTarget, draft.previewTabs);
      store.setPrompt(input.threadTarget, draft.prompt);
    }
  }
  store.clearComposerContent(input.editTarget);
  return recovery;
}

export async function prepareQueuedEditAttachments(input: {
  readonly existingAttachments: ReadonlyArray<ChatAttachment>;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  readonly uploadFiles: (
    files: ReadonlyArray<ComposerFileAttachment>,
  ) => Promise<ReadonlyArray<ChatAttachment>>;
  readonly readImage: (file: File) => Promise<string>;
}) {
  const files = input.files.length === 0 ? [] : await input.uploadFiles(input.files);
  if (files.length !== input.files.length)
    throw new Error("Retry or remove failed uploads before saving.");
  const images = await Promise.all(
    input.images.map(async (image) => ({
      type: "image" as const,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: await input.readImage(image.file),
      ...(image.source ? { source: image.source } : {}),
    })),
  );
  return [...input.existingAttachments, ...images, ...files];
}
