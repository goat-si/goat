import { useEffect } from "react";
import { EnvironmentId, ProjectId, ThreadId } from "@goat/contracts";
import { scopeProjectRef, scopeThreadRef } from "@goat/client-runtime/environment";
import { expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/reactivity";

import { act, render } from "../../../test/render";
import { DraftId, composerTargetKey, useComposerDraftStore } from "../../composerDraftStore";
import { showThreadUndoNotice } from "../../hooks/showThreadUndoNotice";
import { discardComposerDraft } from "../../lib/discardComposerDraft";
import { countPreparingComposerImages } from "./preparingComposerImages";
import { useComposerAttachmentIntake } from "./useComposerAttachmentIntake";

const compression = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("../../lib/imageCompression", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/imageCompression")>()),
  prepareImageForAttachment: compression.prepare,
}));
vi.mock("../../hooks/showThreadUndoNotice", () => ({ showThreadUndoNotice: vi.fn() }));

type IntakeInput = Parameters<typeof useComposerAttachmentIntake>[0];
type Intake = ReturnType<typeof useComposerAttachmentIntake>;

function Harness({ input, ready }: { input: IntakeInput; ready: (value: Intake) => void }) {
  const intake = useComposerAttachmentIntake(input);
  useEffect(() => ready(intake));
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

// A clipboard image arrives as a new File named image.png on every paste.
const pastedImage = (fill = 0) =>
  new File([new Uint8Array(100).fill(fill)], "image.png", { type: "image/png" });
// Compression shrinks an image, so the draft's copy no longer matches the pasted bytes; images
// with different pixels compress to different sizes.
const compress = async (source: File) => {
  const [firstByte = 0] = new Uint8Array(await source.arrayBuffer());
  return {
    ok: true as const,
    file: new File([new Uint8Array(60 + firstByte)], "image.png", { type: "image/png" }),
    recompressed: true as const,
  };
};
// The thread row's discard runs after the composer left that thread; a draft session's discard
// unmounts its composer afterwards.
it.each(["thread", "session"] as const)(
  "a %s draft discarded while an image compresses stays discarded and can be restored",
  async (kind) => {
    const store = useComposerDraftStore.getState();
    const environmentId = EnvironmentId.make(`intake-discard-${kind}`);
    const threadId = ThreadId.make("thread");
    const target =
      kind === "session" ? DraftId.make("intake-discard") : scopeThreadRef(environmentId, threadId);
    if (typeof target === "string") {
      store.setProjectDraftThreadId(scopeProjectRef(environmentId, ProjectId.make("p")), target);
    }
    store.setPrompt(target, "half-written prompt");
    using _draft = {
      [Symbol.dispose]: () => {
        if (typeof target === "string") store.clearDraftThread(target);
        else store.clearComposerContent(target);
      },
    };
    const targetKey = composerTargetKey(target);

    const compressing = deferred<void>();
    const resumeCompression = deferred<void>();
    compression.prepare.mockReset().mockImplementation(async (file: File) => {
      compressing.resolve();
      await resumeCompression.promise;
      return compress(file);
    });

    const input = {
      activeThreadId: threadId,
      activePendingProgress: null,
      activePendingIsResponding: false,
      pendingUserInputs: [],
      supportsQuestionAttachments: false,
      isLiteralPendingAnswer: false,
      projectSelectionRequired: false,
      questionAttachmentTarget: null,
      attachmentTargetKey: targetKey,
      fileStagingLimit: null,
      promptRef: { current: "half-written prompt" },
      composerImagesRef: { current: [] },
      composerFilesRef: { current: [] },
      composerEditorRef: { current: null },
      isRevertingCheckpointRef: { current: false },
      setThreadError: () => {},
      countReservedAttachments: () => countPreparingComposerImages(targetKey),
      addComposerImage: (image) => store.addImages(target, [image]),
      addComposerImagesToDraft: (images) => store.addImages(target, images),
      addComposerFilesToDraft: () => [],
      removeComposerImageFromDraft: (id) => store.removeImage(target, id),
      insertAttachmentReferences: () => false,
    } satisfies IntakeInput;
    let intake!: Intake;
    await using screen = await render(
      <Harness
        input={input}
        ready={(value) => {
          intake = value;
        }}
      />,
    );
    const attaching = intake.addComposerAttachments([pastedImage()]);
    await compressing.promise;

    if (kind === "session") {
      discardComposerDraft(target);
      await screen.unmount();
    } else {
      await screen.unmount();
      discardComposerDraft(target);
    }
    await act(async () => {
      resumeCompression.resolve();
      await attaching;
    });

    expect(countPreparingComposerImages(targetKey)).toBe(0);
    expect(useComposerDraftStore.getState().getComposerDraft(target)).toBeNull();
    const undo = vi.mocked(showThreadUndoNotice).mock.calls.at(-1)![0].undo;
    expect(AsyncResult.isSuccess(await undo())).toBe(true);
    const restored = useComposerDraftStore.getState().getComposerDraft(target);
    expect(restored?.prompt).toBe("half-written prompt");
    expect(restored?.images).toEqual([]);
  },
);
