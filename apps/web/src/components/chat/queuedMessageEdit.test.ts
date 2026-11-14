import { EnvironmentId, ThreadId } from "@goat/contracts";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import { threadContextRecord } from "../../lib/composerContextRecords";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  DraftId,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import { prepareQueuedEditAttachments, recoverQueuedMessageEdit } from "./queuedMessageEdit";

const environmentId = EnvironmentId.make("remote-environment");
const threadTarget = scopeThreadRef(environmentId, ThreadId.make("thread:edit"));
const editTarget = DraftId.make("queued-edit:test");
const file: ComposerFileAttachment = {
  type: "file",
  id: "file:report",
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 6,
  file: new File(["report"], "report.pdf", { type: "application/pdf" }),
};
const image: ComposerImageAttachment = {
  type: "image",
  id: "image:screen",
  name: "screen.png",
  mimeType: "image/png",
  sizeBytes: 5,
  file: new File(["image"], "screen.png", { type: "image/png" }),
  previewUrl: "blob:screen",
};
const uploadedFile = {
  type: "file" as const,
  id: "upload-report",
  name: file.name,
  mimeType: file.mimeType,
  sizeBytes: file.sizeBytes,
};

describe("queued message file edits", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  });

  it.each([
    { images: [], label: "file-only" },
    { images: [image], label: "mixed" },
  ])("preserves a generic file in a $label save", async ({ images }) => {
    const attachments = await prepareQueuedEditAttachments({
      existingAttachments: [],
      images,
      files: [file],
      uploadFiles: async () => [uploadedFile],
      readImage: async () => "data:image/png;base64,aW1hZ2U=",
    });
    expect(attachments.at(-1)).toEqual(uploadedFile);
    expect(attachments.length).toBe(images.length + 1);
    if (images.length > 0)
      expect(attachments[0]).toMatchObject({
        type: "image",
        dataUrl: "data:image/png;base64,aW1hZ2U=",
      });
  });

  it("fails a save instead of dropping a file whose upload is missing", async () => {
    await expect(
      prepareQueuedEditAttachments({
        existingAttachments: [],
        images: [image],
        files: [file],
        uploadFiles: async () => [],
        readImage: async () => "image",
      }),
    ).rejects.toThrow("Retry or remove");
  });

  it("keeps file-only edits when another client starts the queued run", async () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(editTarget, "Original message");
    store.addFiles(editTarget, [file]);
    expect(
      await recoverQueuedMessageEdit({
        editTarget,
        threadTarget,
        originalText: "Original message",
      }),
    ).toBe("kept");
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Original message");
    expect(store.getComposerDraft(threadTarget)?.files).toEqual([file]);
    expect(store.getComposerDraft(editTarget)).toBeNull();
  });

  it("removes a kept edit draft that held a thread mention", async () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(editTarget, "Edited message");
    const mention = threadContextRecord(
      scopeThreadRef(environmentId, ThreadId.make("thread:other")),
      "Other",
    );
    store.setThreadContexts(editTarget, [mention]);
    const prompt = store.getComposerDraft(editTarget)?.prompt;
    expect(
      await recoverQueuedMessageEdit({
        editTarget,
        threadTarget,
        originalText: "Original message",
      }),
    ).toBe("kept");
    expect(store.getComposerDraft(editTarget)).toBeNull();
    expect(store.getComposerDraft(threadTarget)?.threadContexts).toEqual([mention]);
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe(prompt);
  });

  it("recovers text and the remaining original attachment when a run starts after removal", async () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(editTarget, "Original message");
    const originalAttachments = [
      uploadedFile,
      { ...uploadedFile, id: "upload-other", name: "other.pdf" },
    ];
    const remainingAttachments = originalAttachments.filter(
      (attachment) => attachment.id !== "upload-other",
    );
    expect(
      await recoverQueuedMessageEdit({
        editTarget,
        threadTarget,
        originalText: "Original message",
        removedExistingAttachment: true,
        existingAttachments: remainingAttachments,
        loadAttachment: async () => new File(["report"], "report.pdf", { type: "application/pdf" }),
      }),
    ).toBe("kept");
    const recovered = store.getComposerDraft(threadTarget);
    expect(recovered?.prompt).toBe("Original message");
    expect(recovered?.files.map((attachment) => attachment.name)).toEqual([uploadedFile.name]);
    expect(await recovered?.files[0]?.file?.text()).toBe("report");
  });

  it("does not overwrite a new draft while remaining attachments load", async () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(editTarget, "Original message");
    let complete: (value: File) => void = () => {};
    const pending = new Promise<File>((resolve) => {
      complete = resolve;
    });
    const recovery = recoverQueuedMessageEdit({
      editTarget,
      threadTarget,
      originalText: "Original message",
      removedExistingAttachment: true,
      existingAttachments: [uploadedFile],
      loadAttachment: () => pending,
    });
    store.setPrompt(threadTarget, "New draft");
    complete(new File(["report"], "report.pdf", { type: "application/pdf" }));
    expect(await recovery).toBe("failed");
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe("New draft");
    expect(store.getComposerDraft(editTarget)?.prompt).toBe("Original message");
  });

  it("retains the edit when downloading an original attachment fails", async () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(editTarget, "Original message");
    expect(
      await recoverQueuedMessageEdit({
        editTarget,
        threadTarget,
        originalText: "Original message",
        removedExistingAttachment: true,
        existingAttachments: [uploadedFile],
        loadAttachment: async () => {
          throw new Error("offline");
        },
      }),
    ).toBe("failed");
    expect(store.getComposerDraft(editTarget)?.prompt).toBe("Original message");
    expect(store.getComposerDraft(threadTarget)).toBeNull();
  });

  it("recovers an original image when an attachment-only edit loses one attachment", async () => {
    const store = useComposerDraftStore.getState();
    const originalImage = {
      type: "image" as const,
      id: "original-image",
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 5,
    };
    expect(
      await recoverQueuedMessageEdit({
        editTarget,
        threadTarget,
        originalText: "",
        removedExistingAttachment: true,
        existingAttachments: [originalImage],
        loadAttachment: async () => image.file,
      }),
    ).toBe("kept");
    const recovered = store.getComposerDraft(threadTarget);
    expect(recovered?.images.map((attachment) => attachment.id)).toEqual([originalImage.id]);
    expect(recovered?.images[0]?.file).toBe(image.file);
    store.clearComposerContent(threadTarget);
  });

  it("does not overwrite a separate draft when the queued run leaves", async () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadTarget, "Separate draft");
    store.addFiles(editTarget, [file]);
    expect(await recoverQueuedMessageEdit({ editTarget, threadTarget, originalText: "" })).toBe(
      "discarded",
    );
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Separate draft");
    expect(store.getComposerDraft(editTarget)).toBeNull();
  });
});
