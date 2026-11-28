import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { SettingsPageShell } from "./SettingsPageShell";
import { SettingsSidebarNav } from "./SettingsSidebarNav";

vi.mock("./useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => [
    { id: "theme", title: "Theme", to: "/settings/appearance" },
  ],
}));

it("ignores composing keys in the search", async () => {
  await using screen = await render(
    <SidebarProvider defaultOpen>
      <SettingsSidebarNav pathname="/settings/general" />
    </SidebarProvider>,
    { router: "/settings/general" },
  );
  const search = page.getByRole("combobox", { name: "Search settings" });
  await search.fill("theme");
  await expect.element(page.getByRole("option", { name: /Theme/ })).toBeVisible();

  for (const composition of [
    { key: "Enter", isComposing: true, keyCode: 13 },
    { key: "Enter", isComposing: false, keyCode: 229 },
    { key: "Escape", isComposing: true, keyCode: 27 },
    { key: "Escape", isComposing: false, keyCode: 229 },
    { key: "ArrowDown", isComposing: true, keyCode: 40 },
    { key: "ArrowUp", isComposing: true, keyCode: 38 },
  ]) {
    const event = new KeyboardEvent("keydown", { ...composition, bubbles: true, cancelable: true });
    await act(() => search.element().dispatchEvent(event));
    expect(event.defaultPrevented, JSON.stringify(composition)).toBe(false);
    expect(screen.router?.state.location.pathname).toBe("/settings/general");
    await expect.element(search).toHaveValue("theme");
  }

  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe("/settings/appearance"),
  );
});

it("Esc clears a search of spaces and a held Esc keeps Settings open", async () => {
  const root = createRootRoute({ component: Outlet });
  const settingsRoute = createRoute({
    getParentRoute: () => root,
    path: "/settings/general",
    component: () => (
      <SidebarProvider defaultOpen>
        <SettingsSidebarNav pathname="/settings/general" />
        <SettingsPageShell pathname="/settings/general">
          <div />
        </SettingsPageShell>
      </SidebarProvider>
    ),
  });
  const home = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <h1>Home view</h1>,
  });
  const router = createRouter({
    routeTree: root.addChildren([settingsRoute, home]),
    history: createMemoryHistory({ initialEntries: ["/settings/general"] }),
    disableGlobalCatchBoundary: true,
  });
  await router.load();
  // Uses a custom multi-route router with SettingsPageShell and a home fallback route.
  await using _screen = await render(<RouterProvider router={router} />, { router: false });
  const closeSettings = page.getByRole("button", { name: "Close settings" });
  const search = page.getByRole("combobox", { name: "Search settings" });
  await expect.element(closeSettings).toBeVisible();

  for (const text of ["theme", "   "]) {
    await search.fill(text);
    await userEvent.keyboard("{Escape}");
    await expect.element(search).toHaveValue("");
    await expect.element(search).toHaveFocus();
    await act(() =>
      search.element().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          repeat: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await expect.element(closeSettings).toBeVisible();
  }

  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("heading", { name: "Home view" })).toBeVisible();
});

it("tabs through settings sections and moves focus with arrow keys", async () => {
  await page.viewport(1280, 800);
  await using _screen = await render(
    <SidebarProvider defaultOpen>
      <SettingsSidebarNav pathname="/settings/general" />
    </SidebarProvider>,
    { router: "/settings/general" },
  );
  const sections = Array.from(document.querySelectorAll<HTMLElement>("[data-settings-section]"));
  expect(sections.length).toBeGreaterThan(1);
  await userEvent.click(page.getByRole("combobox", { name: "Search settings" }));
  for (const section of sections) {
    await userEvent.tab();
    expect(document.activeElement).toBe(section);
  }
  sections[0]?.focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(sections[1]);
  expect(page.getByRole("tree").query()).toBeNull();
});
