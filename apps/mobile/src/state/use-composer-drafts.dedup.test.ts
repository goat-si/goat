import { expect, it } from "@effect/vitest";
import { onTestFinished, vi } from "vite-plus/test";

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

import { appAtomRegistry } from "./atom-registry";
import { threadOutboxManager } from "./thread-outbox";
import { appendComposerDraftAttachments, composerDraftsAtom } from "./use-composer-drafts";

it("deduplicates before the cap while retaining distinct image bytes and restored duplicates", async () => {
  const load = vi.spyOn(threadOutboxManager, "load").mockResolvedValue(true);
  onTestFinished(() => load.mockRestore());
  const image = (id: string, bytes: string) => ({
    id,
    type: "image" as const,
    name: "pasted-image.png",
    mimeType: "image/png",
    sizeBytes: 3,
    dataUrl: `data:image/png;base64,${bytes}`,
    previewUri: `data:image/png;base64,${bytes}`,
  });
  const key = "new-task:env:dedupe";
  appAtomRegistry.set(composerDraftsAtom, {
    [key]: { text: "", attachments: [image("first", "AQID")] },
  });
  expect(
    appendComposerDraftAttachments(key, [image("duplicate", "AQID"), image("distinct", "BAUG")], {
      maxAttachments: 2,
    }),
  ).toBe(0);
  expect(appAtomRegistry.get(composerDraftsAtom)[key]?.attachments.map((item) => item.id)).toEqual([
    "first",
    "distinct",
  ]);
  expect(
    appendComposerDraftAttachments(key, [image("restored", "AQID")], { allowOverflow: true }),
  ).toBe(0);
  expect(appAtomRegistry.get(composerDraftsAtom)[key]?.attachments.map((item) => item.id)).toEqual([
    "first",
    "distinct",
    "restored",
  ]);
});
