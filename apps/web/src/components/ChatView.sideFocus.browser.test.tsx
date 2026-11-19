import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import { startWorkspaceFocus } from "~/lib/workspaceFocus";
import { useRightPanelStore } from "~/rightPanelStore";
import { DEFAULT_CLIENT_SETTINGS } from "@goat/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});
vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("focuses the side chat composer when its tab is selected", async () => {
  await page.viewport(1400, 900);
  const parent = threadWithHistory("side-focus-parent", 1);
  const side = { ...threadWithHistory("side-focus-child", 1), shell: { sideChatOf: parent.id } };
  using _environment = installFakeEnvironment([parent, side]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const ref = scopeThreadRef(ENVIRONMENT_ID, parent.id);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${parent.id}`] }),
  );
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  await using screen = await render(<AppRoot router={router} />, { container, router: false });
  using _focus = { [Symbol.dispose]: startWorkspaceFocus(router) };
  await expect.element(screen.getByTestId("composer-editor").first()).toBeVisible();
  await act(() => {
    useRightPanelStore.getState().open(ref, "side-chat");
    useRightPanelStore.getState().open(ref, "files");
  });
  await userEvent.click(screen.getByText("Side chat", { exact: true }));
  await expect.element(screen.getByText("Side chat of", { exact: true })).toBeVisible();
  const sideEditor = screen.getByRole("textbox", { name: `Message ${side.title}`, exact: true });
  await expect.element(sideEditor).toHaveFocus();
  await userEvent.keyboard("side draft");
  await expect.element(sideEditor).toHaveTextContent("side draft");
});
