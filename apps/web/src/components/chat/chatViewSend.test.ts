import { type ChatAttachment, EnvironmentId } from "@goat/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  awaiting: [] as string[][],
  uploaded: null as ChatAttachment[] | null,
}));

const settle = vi.hoisted(() => {
  let release: () => void = () => {};
  let settled = Promise.resolve();
  return {
    hold() {
      settled = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release() {
      release();
    },
    settled() {
      return settled;
    },
  };
});

vi.mock(import("../../lib/attachmentUploadQueue"), () => ({
  awaitAttachmentUploads: async (imageIds: ReadonlyArray<string>) => {
    state.awaiting.push([...imageIds]);
    await settle.settled();
  },
  getUploadedAttachments: () => state.uploaded,
}));

import type { ComposerImageAttachment } from "../../composerDraftStore";
import { prepareTurnAttachments } from "./chatViewSend";

const environmentId = EnvironmentId.make("environment-1");
const attachment = (): ComposerImageAttachment => {
  const file = new File(["image bytes"], "shot.png", { type: "image/png" });
  return {
    type: "image",
    id: "image-1",
    name: "shot.png",
    mimeType: file.type,
    sizeBytes: file.size,
    file,
    previewUrl: "blob:shot",
  };
};

describe("prepareTurnAttachments", () => {
  beforeEach(() => {
    state.awaiting = [];
    state.uploaded = null;
    settle.hold();
  });

  it("waits for an upload that is still running before it sends the turn", async () => {
    const prepared = prepareTurnAttachments({
      environmentId,
      attachments: [attachment()],
      usesAttachmentUploads: true,
    });
    await Promise.resolve();
    expect(state.awaiting).toEqual([["image-1"]]);

    state.uploaded = [
      { type: "image", id: "attachment-1", name: "shot.png", mimeType: "image/png", sizeBytes: 11 },
    ];
    settle.release();
    await expect(prepared).resolves.toEqual([
      { type: "image", id: "attachment-1", name: "shot.png", mimeType: "image/png", sizeBytes: 11 },
    ]);
  });

  it("rejects when the upload finished without a server record", async () => {
    const prepared = prepareTurnAttachments({
      environmentId,
      attachments: [attachment()],
      usesAttachmentUploads: true,
    });
    settle.release();
    await expect(prepared).rejects.toThrow("Attachment 'shot.png' failed to upload.");
  });
});
