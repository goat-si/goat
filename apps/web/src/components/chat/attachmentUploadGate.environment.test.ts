import { EnvironmentId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { attachmentUploadGate } from "./useSendAfterUploads";

it("does not leave a displaced environment waiting for another environment's upload", () => {
  const state = attachmentUploadGate({
    imageIds: ["attachment"],
    environmentId: EnvironmentId.make("displaced"),
    uploadsByImageId: {
      attachment: {
        status: "uploading",
        environmentId: EnvironmentId.make("owner"),
        progress: 0.5,
      },
    },
    answering: false,
    uploadsSupported: true,
  });
  expect(state.uploadFailed).toBe(true);
  expect(state.canQueue).toBe(false);
});
