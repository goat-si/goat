import { scopeThreadRef } from "@goat/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlState: () => ({
    _tag: "Success" as const,
    url: "https://assets.test/page.html?sig=1",
    expiresAt: Number.MAX_SAFE_INTEGER,
  }),
  useAssetUrlRefresh: () => async () => null,
}));

import { WorkspaceBrowserPreview } from "./WorkspaceBrowserPreview";

const ENVIRONMENT = EnvironmentId.make("local");
const THREAD = scopeThreadRef(ENVIRONMENT, ThreadId.make("thread-1"));

function preview(refreshRequestId: number) {
  return (
    <WorkspaceBrowserPreview
      environmentId={ENVIRONMENT}
      threadRef={THREAD}
      draft={false}
      absolutePath="/home/dev/repo/page.html"
      workspaceRoot="/home/dev/repo"
      title="page.html"
      workspaceMutationId="mutation-1"
      refreshRequestId={refreshRequestId}
    />
  );
}

describe("WorkspaceBrowserPreview", () => {
  it("reloads the document on a refresh while the workspace revision stays the same", async () => {
    await using screen = await render(preview(0), { router: false /* nothing links */ });
    const frame = () => screen.container.querySelector("iframe");
    await vi.waitFor(() => expect(frame()).not.toBeNull());
    const before = frame()!;
    expect(before.getAttribute("src")).toBe(
      "https://assets.test/page.html?sig=1&workspace-revision=mutation-1",
    );
    await screen.rerender(preview(1));
    await vi.waitFor(() => expect(frame()).not.toBe(before));
    expect(frame()!.getAttribute("src")).toBe(
      "https://assets.test/page.html?sig=1&workspace-revision=mutation-1%3Afiles%3A1",
    );
  });
});
