import { describe, expect, it } from "vite-plus/test";
import { buildIncomingShareDraft } from "./incoming-share-model";

describe("incoming shared attachment IDs", () => {
  it("creates IDs safe for composer context for files and images", async () => {
    const draft = await buildIncomingShareDraft({
      id: "share-1",
      createdAt: "2026-07-15T10:00:00.000Z",
      payloads: [
        {
          shareType: "file",
          value: "file:///shared/a.pdf",
          mimeType: "application/pdf",
          originalName: "a.pdf",
        },
        { shareType: "image", value: "file:///shared/a.png", mimeType: "image/png" },
      ],
      resolvedPayloads: [],
      fileReader: {
        readBase64: async () => "YWJj",
        readSize: async () => 3,
        removeOwnedFile: async () => {},
      },
    });
    expect(draft.attachments.map((attachment) => attachment.id)).toEqual([
      "share-1-file-0",
      "share-1-image-1",
    ]);
  });
});
