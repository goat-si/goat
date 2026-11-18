import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import { ThreadId } from "@goat/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@goat/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily; importing it here keeps its first transform out of the test.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { loadGhosttyRuntime } from "~/terminal/ghostty/runtime";
import { useTerminalUiStateStore } from "~/terminalUiStateStore";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
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

it("entering a thread on a touch tablet focuses its open drawer terminal and never the composer", async () => {
  const realMatchMedia = window.matchMedia.bind(window);
  using _touch = vi
    .spyOn(window, "matchMedia")
    .mockImplementation((query) => realMatchMedia(query === "(pointer: coarse)" ? "all" : query));
  const first = threadWithHistory("thread-terminal-touch-a", 1);
  const second = threadWithHistory("thread-terminal-touch-b", 1);
  using _environment = installFakeEnvironment([first, second]);
  // The drawer terminal takes focus only once Ghostty's WebAssembly has loaded.
  await loadGhosttyRuntime();
  // iPad Pro 11 in landscape: the desktop layout, above max-sm.
  await page.viewport(1194, 834);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  useTerminalUiStateStore
    .getState()
    .setTerminalOpen(scopeThreadRef(ENVIRONMENT_ID, ThreadId.make(second.id)), true);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${first.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const composer = page.getByTestId("composer-editor");
  await expect.element(page.getByText(`Answer 0 for ${first.id}.`)).toBeVisible();

  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: second.id },
    }),
  );
  await expect.element(page.getByText(`Answer 0 for ${second.id}.`)).toBeVisible();
  await vi.waitFor(() =>
    expect(document.activeElement?.closest('[data-terminal-owner="drawer"]')).not.toBeNull(),
  );
  expect(document.activeElement).not.toBe(composer.element());
});
