import { EnvironmentId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { readAttachmentUpload, useAttachmentUploadStore } from "../../lib/attachmentUploadQueue";
import { releaseGoatBotAttachments, retainGoatBotAttachments } from "./goatBotAttachments";

it("does not release a newer environment's upload when an old bot owner leaves", () => {
  const oldEnvironment = EnvironmentId.make("old-bot");
  const newEnvironment = EnvironmentId.make("new-bot");
  const image = {
    type: "image" as const,
    id: "bot-attachment",
    name: "bot.png",
    mimeType: "image/png",
    sizeBytes: 3,
    previewUrl: "blob:bot-attachment",
    file: new File(["one"], "bot.png", { type: "image/png" }),
  };
  using _revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  useAttachmentUploadStore.setState({
    uploadsByImageId: {
      [image.id]: { status: "ready", environmentId: oldEnvironment, attachmentId: "old-id" },
    },
  });
  retainGoatBotAttachments([image]);
  useAttachmentUploadStore.setState({
    uploadsByImageId: {
      [image.id]: { status: "ready", environmentId: newEnvironment, attachmentId: "new-id" },
    },
  });
  releaseGoatBotAttachments([image]);
  expect(readAttachmentUpload(image.id)).toMatchObject({
    status: "ready",
    environmentId: newEnvironment,
    attachmentId: "new-id",
  });
  useAttachmentUploadStore.setState({ uploadsByImageId: {} });
});
