import { EnvironmentId, ThreadId, type PreviewSessionSnapshot } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { applyPreviewServerSnapshot, clearThreadPreviewState } from "../../previewStateStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { usePreviewFindAvailable } from "./findAvailability";

vi.mock("./previewBridge", () => ({
  previewBridge: {
    findInPage: vi.fn(),
    stopFindInPage: vi.fn(),
    onFindResult: vi.fn(),
  },
}));

it("renders a Find subscriber only when the active tab's eligibility changes", async () => {
  const thread = {
    environmentId: EnvironmentId.make("find-environment"),
    threadId: ThreadId.make("find-thread"),
  };
  const tab: PreviewSessionSnapshot = {
    threadId: thread.threadId,
    tabId: "find-tab",
    runtime: "desktop",
    navStatus: { _tag: "Success", url: "https://example.com", title: "Example" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-11-19T00:00:00.000Z",
  };
  const rendered = vi.fn<(available: boolean) => void>();
  function FindSubscriber() {
    rendered(usePreviewFindAvailable(thread));
    return null;
  }

  using cleanup = new DisposableStack();
  cleanup.defer(() => {
    useRightPanelStore.getState().close(thread);
    clearThreadPreviewState(thread);
  });
  applyPreviewServerSnapshot(thread, tab);
  useRightPanelStore.getState().openBrowser(thread, tab.tabId);
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <FindSubscriber />
    </AppAtomRegistryProvider>,
  );

  expect(rendered).toHaveBeenLastCalledWith(true);
  rendered.mockClear();
  await act(() => applyPreviewServerSnapshot(thread, { ...tab, canGoBack: true }));
  expect(rendered).not.toHaveBeenCalled();

  await act(() =>
    applyPreviewServerSnapshot(thread, { ...tab, runtime: "server", serverRendered: true }),
  );
  expect(rendered).toHaveBeenLastCalledWith(false);

  await act(() => useRightPanelStore.getState().close(thread));
  rendered.mockClear();
  await act(() => applyPreviewServerSnapshot(thread, tab));
  expect(rendered).not.toHaveBeenCalled();
});
