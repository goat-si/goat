import { expect, it, vi } from "vite-plus/test";
const composerDraftFileMocks = vi.hoisted(() => {
  let document = JSON.stringify({ schemaVersion: 1, drafts: {} });
  let readError: Error | null = null;
  let writeError: Error | null = null;
  let releaseRead: (() => void) | null = null;
  let readBarrier = Promise.resolve();
  let nextWriteBarrier: Promise<void> | null = null;
  let onWrite: (() => void) | null = null;
  const writes: string[] = [];
  const readImage = vi.fn(async () => "YWJj");

  return {
    readImage,
    blockRead() {
      readBarrier = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
    },
    releaseRead() {
      releaseRead?.();
      releaseRead = null;
    },
    getDocument() {
      return document;
    },
    setDocument(value: unknown) {
      document = JSON.stringify(value);
    },
    setReadError(error: Error | null) {
      readError = error;
    },
    setWriteError(error: Error | null) {
      writeError = error;
    },
    setNextWriteBarrier(barrier: Promise<void> | null) {
      nextWriteBarrier = barrier;
    },
    setOnWrite(callback: (() => void) | null) {
      onWrite = callback;
    },
    getWrites(): ReadonlyArray<string> {
      return writes;
    },
    resetWrites() {
      writes.length = 0;
    },
    Directory: class {
      create() {}

      list() {
        return [];
      }
    },
    File: class {
      exists = true;
      parentDirectory = null;

      create() {}

      moveSync() {}

      async text() {
        await readBarrier;
        if (readError) throw readError;
        return document;
      }

      async base64() {
        return readImage();
      }

      write(value: string) {
        if (writeError) {
          throw writeError;
        }
        if (nextWriteBarrier) {
          const barrier = nextWriteBarrier;
          nextWriteBarrier = null;
          return barrier.then(() => {
            document = value;
            writes.push(value);
            onWrite?.();
          });
        }
        document = value;
        writes.push(value);
        onWrite?.();
      }
    },
  };
});

const composerAttachmentCleanupMocks = vi.hoisted(() => ({
  remove: vi.fn(async () => undefined),
  releaseUploads: vi.fn(async () => undefined),
}));

const incomingShareStorageMocks = vi.hoisted(() => ({
  load: vi.fn<typeof import("../features/sharing/incoming-share-storage").loadIncomingShareDrafts>(
    async () => [],
  ),
}));

vi.mock("expo-file-system", () => ({
  Directory: composerDraftFileMocks.Directory,
  File: composerDraftFileMocks.File,
  Paths: { document: { uri: "file:///documents" } },
}));

vi.mock("../lib/composerImages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/composerImages")>()),
  removePersistedComposerAttachmentFile: composerAttachmentCleanupMocks.remove,
}));

vi.mock("../lib/uuid", () => ({ uuidv4: () => "uuid", randomHex: () => "0000" }));
vi.mock("./assets", () => ({ assetEnvironment: {} }));
vi.mock("./attachments", () => ({ attachmentEnvironment: {} }));
vi.mock("./session", () => ({ environmentSession: {} }));
vi.mock("@goat/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: () => Symbol("rpc-command"),
  executeAtomQuery: () => {
    throw new Error("Unexpected network query in the inline read test");
  },
  runAtomCommand: () => {
    throw new Error("Unexpected network command in the inline read test");
  },
  squashAtomCommandFailure: (result: { readonly error: unknown }) => result.error,
}));

vi.mock("../lib/attachmentUpload", () => ({
  releasePendingAttachmentUploads: composerAttachmentCleanupMocks.releaseUploads,
}));

vi.mock("../features/sharing/incoming-share-storage", () => ({
  loadIncomingShareDrafts: incomingShareStorageMocks.load,
}));

import {
  decodePersistedComposerState,
  mergeComposerDraftContentState,
} from "./use-composer-drafts";
import { composerContextSendBlockReason } from "../lib/composerContext";
import { decodeIncomingShareDraft } from "../features/sharing/incoming-share-model";

const file = {
  id: "share-1:file:0",
  type: "file" as const,
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 3,
  fileUri: "file:///shared/report.pdf",
};

it("loads an old shared file and provides a valid send context", () => {
  const share = decodeIncomingShareDraft({
    schemaVersion: 1,
    id: "share-1",
    createdAt: "2026-07-15T10:00:00Z",
    text: "",
    attachments: [file],
    warnings: [],
  });
  expect(share.attachments[0]?.id).toBe("share-1-file-0");
  const draft = decodePersistedComposerState({
    schemaVersion: 1,
    drafts: { thread: { text: "", attachments: [file] } },
  }).drafts.thread;
  expect(draft?.attachments[0]?.id).toBe("share-1-file-0");
  expect(draft?.context?.records).toHaveLength(1);
  expect(composerContextSendBlockReason(draft?.context)).toBeNull();
});

it("deduplicates old and new spellings of the same shared attachment", () => {
  const existing = decodePersistedComposerState({
    schemaVersion: 1,
    drafts: { thread: { text: "", attachments: [file] } },
  }).drafts;
  const merged = mergeComposerDraftContentState(existing, "thread", {
    text: "",
    attachments: [{ ...file, id: "share-1-file-0" }],
  });
  expect(merged.thread?.attachments).toHaveLength(1);
});

it("retains existing file references when recovering a colon-ID draft", () => {
  const record = {
    version: 1,
    kind: "file",
    contextId: "file_original",
    label: "report.pdf",
    attachmentId: file.id,
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
  };
  const text = "[report.pdf](goat-context://v1/file/file_original) ";
  const draft = decodePersistedComposerState({
    schemaVersion: 1,
    drafts: { thread: { text, attachments: [file], context: { version: 1, records: [record] } } },
  }).drafts.thread;
  expect(draft?.text).toBe(text);
  expect(draft?.context?.records).toMatchObject([
    { contextId: "file_original", attachmentId: "share-1-file-0" },
  ]);
  expect(composerContextSendBlockReason(draft?.context)).toBeNull();
});
