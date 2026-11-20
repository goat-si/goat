import { EnvironmentId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { DraftId } from "../../composerDraftStore";
import { useAttachmentUploadStore } from "../../lib/attachmentUploadQueue";
import { ComposerAttachmentFileList } from "./ComposerAttachmentStrip";

it("shows a retry control when another environment takes an attachment upload", async () => {
  const owner = EnvironmentId.make("owner");
  const displaced = EnvironmentId.make("displaced");
  const file = {
    type: "file" as const,
    id: "displaced-file",
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 3,
    file: new File(["one"], "notes.txt"),
  };
  useAttachmentUploadStore.setState({
    uploadsByImageId: {
      [file.id]: { status: "ready", environmentId: owner, attachmentId: "owner-id" },
    },
  });
  try {
    await using screen = await render(
      <ComposerAttachmentFileList
        files={[file]}
        resolvedTheme="light"
        supportsAttachmentUploads
        maxFileAttachmentBytes={1024}
        fileStagingLimit={1024}
        environmentId={displaced}
        attachmentDraftTarget={DraftId.make("draft")}
        canOperateThread
        onPreviewFile={vi.fn()}
        onRemoveFile={vi.fn()}
      />,
    );
    await expect
      .element(screen.getByRole("button", { name: "Retry upload for notes.txt" }))
      .toBeVisible();
  } finally {
    useAttachmentUploadStore.setState({ uploadsByImageId: {} });
  }
});
