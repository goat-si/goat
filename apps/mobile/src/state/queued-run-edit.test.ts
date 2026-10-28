import { describe, expect, it, vi } from "vite-plus/test";
import { Atom } from "effect/reactivity";
import {
  ChatAttachmentId,
  ComposerContextId,
  MessageId,
  RunId,
  type ChatAttachment,
  type OrchestrationMessageContext,
} from "@goat/contracts";

import { appAtomRegistry } from "./atom-registry";
import {
  activeComposerDraftKey,
  beginQueuedRunEdit,
  getQueuedRunEdit,
  queuedEditDraftKey,
  removeQueuedRunEditAttachment,
  resolveQueuedEditPayload,
  setActiveComposerDraftText,
  startQueuedRunEditSave,
  type QueuedRunEdit,
} from "./queued-run-edit";
import { threadComposerErrorsAtom } from "./thread-composer-error";
import {
  appendComposerDraftAttachments,
  getComposerDraftSnapshot,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "./use-composer-drafts";

vi.mock("expo-file-system", () => {
  let document = '{"schemaVersion":1,"drafts":{}}';
  return {
    Directory: class {
      create() {}
      list() {
        return [];
      }
    },
    File: class {
      exists = true;
      parentDirectory = null;
      name = "drafts.json";
      create() {}
      moveSync() {}
      async text() {
        return document;
      }
      write(value: string) {
        document = value;
      }
    },
    Paths: { document: "/documents" },
  };
});
vi.mock("../features/sharing/incoming-share-storage", () => ({
  loadIncomingShareDrafts: async () => [],
}));

const image = (id: string): ChatAttachment => ({
  type: "image",
  id: ChatAttachmentId.make(id),
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: 10,
});

function edit(attachments: ReadonlyArray<ChatAttachment>): QueuedRunEdit {
  return {
    runId: RunId.make("run-1"),
    messageId: MessageId.make("message-1"),
    originalText: "original",
    existingAttachments: attachments,
  };
}

function context(attachmentIds: ReadonlyArray<string>): OrchestrationMessageContext {
  return {
    version: 1,
    records: attachmentIds.map((attachmentId, index) => ({
      version: 1,
      kind: "image",
      contextId: ComposerContextId.make(`ctx-${index}`),
      label: `${attachmentId}.png`,
      attachmentId,
      name: `${attachmentId}.png`,
      mimeType: "image/png",
      sizeBytes: 10,
    })),
  };
}

describe("resolveQueuedEditPayload", () => {
  it("resends the kept server attachments ahead of the newly uploaded ones", () => {
    const payload = resolveQueuedEditPayload({
      edit: edit([image("kept")]),
      draftContext: undefined,
      draftAttachments: [{ id: "draft-1" }],
      uploaded: [image("uploaded")],
    });

    expect(payload.attachments.map((attachment) => attachment.id)).toEqual(["kept", "uploaded"]);
  });

  it("rebinds context records from the draft's ids to the uploaded ones", () => {
    const payload = resolveQueuedEditPayload({
      edit: edit([]),
      draftContext: context(["draft-1"]),
      draftAttachments: [{ id: "draft-1" }],
      uploaded: [image("uploaded")],
    });

    expect(payload.context?.records).toEqual([
      expect.objectContaining({ attachmentId: "uploaded" }),
    ]);
  });

  it("drops the record of an attachment the user removed", () => {
    const payload = resolveQueuedEditPayload({
      edit: edit([image("kept")]),
      draftContext: context(["kept", "gone"]),
      draftAttachments: [],
      uploaded: [],
    });

    expect(payload.attachments.map((attachment) => attachment.id)).toEqual(["kept"]);
    expect(payload.context?.records).toEqual([expect.objectContaining({ attachmentId: "kept" })]);
  });
});

describe("beginQueuedRunEdit", () => {
  it("ends a changed edit when its run starts, without the thread's composer mounted", () => {
    const threadKey = "env-exit:thread-exit";
    const runId = RunId.make("run-1");
    const runs = Atom.make<ReadonlyArray<{ readonly id: RunId; readonly status: string }> | null>([
      { id: runId, status: "queued" },
    ]);
    setComposerDraftText(threadKey, "other work");
    beginQueuedRunEdit(threadKey, edit([]), runs);
    setComposerDraftText(queuedEditDraftKey(threadKey, runId), "changed");

    appAtomRegistry.set(runs, [{ id: runId, status: "running" }]);

    expect(getQueuedRunEdit(threadKey)).toBeNull();
    expect(getComposerDraftSnapshot(threadKey).text).toBe("other work");
    expect(appAtomRegistry.get(threadComposerErrorsAtom)[threadKey]?.message).toBe(
      "That message already started, so the edit was discarded.",
    );
  });

  it("recovers an attachment-only edit into an empty thread draft", async () => {
    await waitForComposerDraftsLoaded();
    const threadKey = "env-exit:thread-attachment-only";
    const runId = RunId.make("run-1");
    const runs = Atom.make<ReadonlyArray<{ readonly id: RunId; readonly status: string }> | null>([
      { id: runId, status: "queued" },
    ]);
    beginQueuedRunEdit(threadKey, { ...edit([]), originalText: "" }, runs);
    const attachment = {
      id: "new-image",
      type: "image" as const,
      name: "photo.png",
      mimeType: "image/png" as const,
      sizeBytes: 3,
      previewUri: "data:image/png;base64,YWJj",
      dataUrl: "data:image/png;base64,YWJj",
    };
    appendComposerDraftAttachments(queuedEditDraftKey(threadKey, runId), [attachment]);

    appAtomRegistry.set(runs, [{ id: runId, status: "running" }]);

    expect(getQueuedRunEdit(threadKey)).toBeNull();
    expect(getComposerDraftSnapshot(threadKey).attachments).toEqual([attachment]);
    expect(getComposerDraftSnapshot(queuedEditDraftKey(threadKey, runId)).attachments).toEqual([]);
    expect(appAtomRegistry.get(threadComposerErrorsAtom)[threadKey]?.message).toBe(
      "That message already started. Your edit is back in the composer.",
    );
  });

  it("lets a failed save retire an edit whose run started while saving", () => {
    const threadKey = "env-save:thread-started";
    const runId = RunId.make("run-1");
    const runs = Atom.make<ReadonlyArray<{ readonly id: RunId; readonly status: string }> | null>([
      { id: runId, status: "queued" },
    ]);
    setComposerDraftText(threadKey, "other work");
    beginQueuedRunEdit(threadKey, edit([]), runs);
    setComposerDraftText(queuedEditDraftKey(threadKey, runId), "changed");
    const finishSave = startQueuedRunEditSave(threadKey);
    appAtomRegistry.set(runs, [{ id: runId, status: "running" }]);
    expect(getQueuedRunEdit(threadKey)).not.toBeNull();
    expect(finishSave?.(false)).toBe(false);
    expect(getQueuedRunEdit(threadKey)).toBeNull();
    expect(getComposerDraftSnapshot(threadKey).text).toBe("other work");
  });

  it("reports a cleared edit as discarded when the run starts", () => {
    const threadKey = "env-exit:thread-cleared";
    const runId = RunId.make("run-1");
    const runs = Atom.make<ReadonlyArray<{ readonly id: RunId; readonly status: string }> | null>([
      { id: runId, status: "queued" },
    ]);
    beginQueuedRunEdit(threadKey, edit([]), runs);
    setComposerDraftText(queuedEditDraftKey(threadKey, runId), "");

    appAtomRegistry.set(runs, [{ id: runId, status: "running" }]);

    expect(getQueuedRunEdit(threadKey)).toBeNull();
    expect(getComposerDraftSnapshot(threadKey).text).toBe("");
    expect(appAtomRegistry.get(threadComposerErrorsAtom)[threadKey]?.message).toBe(
      "That message already started, so the edit was discarded.",
    );
  });

  it("treats a removed server attachment as a change when the run starts", () => {
    const threadKey = "env-exit:thread-removed";
    const runId = RunId.make("run-1");
    const runs = Atom.make<ReadonlyArray<{ readonly id: RunId; readonly status: string }> | null>([
      { id: runId, status: "queued" },
    ]);
    setComposerDraftText(threadKey, "other work");
    beginQueuedRunEdit(threadKey, edit([image("kept")]), runs);
    removeQueuedRunEditAttachment(threadKey, "kept");

    appAtomRegistry.set(runs, [{ id: runId, status: "running" }]);

    expect(getQueuedRunEdit(threadKey)).toBeNull();
    expect(appAtomRegistry.get(threadComposerErrorsAtom)[threadKey]?.message).toBe(
      "That message already started, so the edit was discarded.",
    );
  });
});

describe("activeComposerDraftKey", () => {
  const threadKey = "env:thread";
  const editKey = queuedEditDraftKey(threadKey, RunId.make("run-1"));

  it("keeps a queued edit's draft while that edit is open", () => {
    expect(activeComposerDraftKey(threadKey, editKey, edit([]))).toBe(editKey);
  });

  it("falls back to the thread's draft once the edit has ended", () => {
    expect(activeComposerDraftKey(threadKey, editKey, null)).toBe(threadKey);
  });
});

it.each([
  { threadKey: "env-settings:new-thread", draftKey: "new-task:draft-settings" },
  { threadKey: "env-settings:pending-thread", draftKey: "pending-task:message-settings" },
])("keeps settings prompt changes in $draftKey", async ({ threadKey, draftKey }) => {
  await waitForComposerDraftsLoaded();
  setComposerDraftText(threadKey, "other work");
  setComposerDraftText(draftKey, "task prompt");

  setActiveComposerDraftText(threadKey, draftKey, "ultrathink\ntask prompt");

  expect(getComposerDraftSnapshot(draftKey).text).toBe("ultrathink\ntask prompt");
  expect(getComposerDraftSnapshot(threadKey).text).toBe("other work");
});

it("redirects a settings callback after the queued edit ends", () => {
  const threadKey = "env-settings:thread-settings";
  const editKey = queuedEditDraftKey(threadKey, RunId.make("run-1"));
  setActiveComposerDraftText(threadKey, editKey, "updated in settings");
  expect(getComposerDraftSnapshot(threadKey).text).toBe("updated in settings");
  expect(getComposerDraftSnapshot(editKey).text).toBe("");
});
