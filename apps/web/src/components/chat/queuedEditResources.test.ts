import { EnvironmentId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useAttachmentUploadStore } from "../../lib/attachmentUploadQueue";
import { releaseUnownedQueuedEditAttachments } from "./queuedEditResources";

it("releases a staged image and its preview only once when cleanup repeats", () => {
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  const image = {
    type: "image" as const,
    id: "idempotent-image",
    name: "image.png",
    mimeType: "image/png",
    sizeBytes: 1,
    file: new File(["x"], "image.png"),
    previewUrl: "blob:idempotent",
  };
  useAttachmentUploadStore.setState({
    uploadsByImageId: {
      [image.id]: {
        status: "ready",
        environmentId: EnvironmentId.make("env"),
        attachmentId: "upload",
      },
    },
  });
  using revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  releaseUnownedQueuedEditAttachments([image]);
  releaseUnownedQueuedEditAttachments([{ ...image }]);
  expect(revoke).toHaveBeenCalledExactlyOnceWith(image.previewUrl);
});
