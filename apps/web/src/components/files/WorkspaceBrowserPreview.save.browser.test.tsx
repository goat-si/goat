import { scopeThreadRef } from "@goat/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlState: () => ({
    _tag: "Success" as const,
    url: "https://assets.test/file.pdf",
    expiresAt: Number.MAX_SAFE_INTEGER,
    fileRevision: "1",
  }),
  useAssetUrlRefresh: () => async () => "https://assets.test/file.pdf",
}));
vi.mock(import("./BrowserDocumentFrame"), () => ({
  isPdfPreviewFile: (path: string) => path.endsWith(".pdf"),
  BrowserDocumentFrame: () => <div>PDF preview</div>,
}));
import { WorkspaceBrowserPreview } from "./WorkspaceBrowserPreview";

it("offers to save a workspace PDF", async () => {
  const environmentId = EnvironmentId.make("local");
  await using screen = await render(
    <WorkspaceBrowserPreview
      environmentId={environmentId}
      threadRef={scopeThreadRef(environmentId, ThreadId.make("thread-1"))}
      draft={false}
      absolutePath="/repo/file.pdf"
      workspaceRoot="/repo"
      title="file.pdf"
      workspaceMutationId={null}
      refreshRequestId={0}
    />,
    { router: false /* nothing links */ },
  );
  await expect.element(screen.getByRole("button", { name: "Save file" })).toBeVisible();
});
