import { EnvironmentId, ThreadId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import fixture from "./pdf/fixtures/mixed.pdf?raw";
import { WorkspaceBrowserPreview } from "./WorkspaceBrowserPreview";

const { assetUrlState } = vi.hoisted(() => ({
  assetUrlState: vi.fn<() => import("~/assets/assetUrls").AssetUrlState>(),
}));
vi.mock("~/assets/assetUrls", async () => ({
  resolveAssetUrl: (await import("@goat/client-runtime/state/assets")).resolveAssetUrl,
  useAssetUrlState: assetUrlState,
  useAssetUrlRefresh: () => async () => null,
}));

it("keeps the PDF page across URL renewals and resets it when the file changes", async () => {
  const original = URL.createObjectURL(new Blob([fixture], { type: "application/pdf" }));
  const edited = URL.createObjectURL(new Blob([fixture], { type: "application/pdf" }));
  using _urls = {
    [Symbol.dispose]: () => {
      URL.revokeObjectURL(original);
      URL.revokeObjectURL(edited);
    },
  };
  const preview = (mutation: string) => (
    <div style={{ height: 600, width: 800, display: "flex" }}>
      <WorkspaceBrowserPreview
        environmentId={EnvironmentId.make("test")}
        threadRef={{ environmentId: EnvironmentId.make("test"), threadId: ThreadId.make("test") }}
        draft={false}
        workspaceRoot="/repo"
        absolutePath="/repo/planning.pdf"
        title="Planning"
        workspaceMutationId={mutation}
        refreshRequestId={0}
      />
    </div>
  );
  assetUrlState.mockReturnValue({
    _tag: "Success",
    url: `${original}#initial`,
    expiresAt: 0,
    fileRevision: "one",
  });
  await using screen = await render(preview("first"));
  const pageNumber = screen.getByRole("spinbutton", { name: "PDF page number" });
  await expect.element(pageNumber).toHaveValue(1);
  await page.getByRole("button", { name: "Next PDF page" }).click();
  await expect.element(pageNumber).toHaveValue(2);
  const opened = screen.getByRole("region", { name: "Planning PDF viewer" }).element();

  assetUrlState.mockReturnValue({
    _tag: "Success",
    url: `${original}#renewed`,
    expiresAt: 0,
    fileRevision: "one",
  });
  await screen.rerender(preview("second"));
  expect(screen.getByRole("region", { name: "Planning PDF viewer" }).element()).toBe(opened);
  await expect.element(pageNumber).toHaveValue(2);

  assetUrlState.mockReturnValue({
    _tag: "Success",
    url: `${edited}#changed`,
    expiresAt: 0,
    fileRevision: "two",
  });
  await screen.rerender(preview("third"));
  await expect.element(pageNumber).toHaveValue(1);
  expect(screen.getByRole("region", { name: "Planning PDF viewer" }).element()).not.toBe(opened);

  assetUrlState.mockReturnValue({
    _tag: "Success",
    url: `${edited}#changed`,
    expiresAt: 0,
    waiting: true,
  });
  await screen.rerender(preview("fourth"));
  await expect.element(pageNumber).not.toBeInTheDocument();
  assetUrlState.mockReturnValue({ _tag: "Success", url: `${original}#initial`, expiresAt: 0 });
  await screen.rerender(preview("fourth"));
  await expect.element(pageNumber).toHaveValue(1);
});
