import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@goat/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The thread route loads ChatView lazily; its first transform would eat the test's timeout.
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
import { makeThreadFixture } from "../test-fixtures";
import { SidebarSearchResultRow } from "./sidebar/SidebarThreadRow";

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

it("keeps the title when dragging a search result", async () => {
  await page.viewport(1400, 900);
  const [first, second] = [threadWithHistory("visible", 1), threadWithHistory("search-target", 1)];
  using _environment = installFakeEnvironment([first, second]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    projectsSidebarEnabled: false,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${first.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  // Opening a thread focuses its composer a frame later, even over the search (goat-si/goat#3353).
  await expect.element(page.getByRole("textbox", { name: /^Message/ })).toHaveFocus();
  await userEvent.fill(page.getByRole("combobox", { name: "Search threads" }), "search-target");
  const result = page.getByRole("option", { name: /Thread search-target/ });
  await expect.element(result).toBeVisible();
  const bounds = result.element().getBoundingClientRect();
  const pointer = (type: string, x: number, y: number) =>
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      isPrimary: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX: x,
      clientY: y,
    });
  using _release = {
    [Symbol.dispose]: () => document.dispatchEvent(pointer("pointerup", -100, 100)),
  };
  await act(() => {
    result.element().dispatchEvent(pointer("pointerdown", bounds.x + 10, bounds.y + 10));
    document.dispatchEvent(pointer("pointermove", -100, 100));
  });
  await vi.waitFor(() => {
    expect(
      document.querySelector('body > div[aria-hidden="true"].pointer-events-none')?.textContent,
    ).toBe(second.title);
  });
});

it("shows the search result drag preview while still inside the list", async () => {
  await page.viewport(1400, 900);
  const [first, second] = [threadWithHistory("visible", 1), threadWithHistory("search-target", 1)];
  using _environment = installFakeEnvironment([first, second]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    projectsSidebarEnabled: false,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${first.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  // Opening a thread focuses its composer a frame later, even over the search (goat-si/goat#3353).
  await expect.element(page.getByRole("textbox", { name: /^Message/ })).toHaveFocus();
  await userEvent.fill(page.getByRole("combobox", { name: "Search threads" }), "search-target");
  const result = page.getByRole("option", { name: /Thread search-target/ });
  await expect.element(result).toBeVisible();
  const bounds = result.element().getBoundingClientRect();
  const pointer = (type: string, x: number, y: number) =>
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      isPrimary: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX: x,
      clientY: y,
    });
  using _release = {
    [Symbol.dispose]: () => document.dispatchEvent(pointer("pointerup", -100, 100)),
  };
  await act(() => {
    result.element().dispatchEvent(pointer("pointerdown", bounds.x + 10, bounds.y + 10));
    document.dispatchEvent(pointer("pointermove", bounds.x + 30, bounds.y + 10));
  });
  await vi.waitFor(() => {
    expect(
      document.querySelector('body > div[aria-hidden="true"].pointer-events-none')?.textContent,
    ).toBe(second.title);
  });
});

it("keeps focus in the search box when a click picks a search result", async () => {
  const onSelect = vi.fn();
  await using screen = await render(
    <>
      <input aria-label="Search threads" />
      <ul role="listbox">
        <SidebarSearchResultRow
          isSettled={false}
          thread={makeThreadFixture({ title: "Invoice export" })}
          project={null}
          projectDisplayName={null}
          environmentLabel={null}
          environmentMachine="server"
          providerEntryByInstanceId={new Map()}
          isHighlighted={false}
          isRouteActive={false}
          resultId="result-0"
          searchMatch={null}
          searchQuery="invoice"
          onHighlight={() => {}}
          onSelect={onSelect}
          onFileDropThreads={() => {}}
        />
      </ul>
    </>,
  );
  const search = screen.getByRole("textbox", { name: "Search threads" });
  await userEvent.click(search);
  await userEvent.click(screen.getByRole("option"));
  expect(onSelect).toHaveBeenCalledOnce();
  // Picking clears the results; a focused result would drop focus, and its recovery scrolls the list.
  await expect.element(search).toHaveFocus();
});
