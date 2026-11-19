import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@goat/contracts/settings";
import {
  compileResolvedKeybindingsConfig,
  mergeWithDefaultKeybindings,
} from "@goat/shared/keybindings";
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
import { render } from "../../test/render";
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

it("a shortcut conditioned on rightPanelOpen sees the thread's open right panel", async () => {
  await page.viewport(1280, 800);
  const thread = threadWithHistory("thread-panel-shortcut", 1);
  using _environment = installFakeEnvironment([thread], {
    keybindings: mergeWithDefaultKeybindings(
      compileResolvedKeybindingsConfig([
        {
          key: "ctrl+alt+9",
          command: "rightPanel.toggle",
          when: "rightPanelOpen && !terminalFocus",
        },
      ]),
    ),
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const composer = page.getByTestId("composer-editor");
  const toggle = page.getByRole("button", { name: "Toggle right panel", exact: true });
  await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect.element(toggle).toHaveAttribute("aria-pressed", "true");
  await composer.click();
  await userEvent.keyboard("{Control>}{Alt>}9{/Alt}{/Control}");
  await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
});
