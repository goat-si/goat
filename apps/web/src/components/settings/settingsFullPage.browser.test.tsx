import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { routeTree } from "../../routeTree.gen";
import { startMainAppLocationTracking } from "../sidebar/mainAppLocation";

// The real root and chat shells bootstrap server auth and the whole app; keep only their outlets.
vi.mock("../../routes/__root", async () => {
  const { createRootRoute, Outlet } = await import("@tanstack/react-router");
  const { SidebarProvider } = await import("../ui/sidebar");
  return {
    Route: createRootRoute({
      beforeLoad: () => ({ authGateState: { status: "authenticated" } as const }),
      component: () => (
        <SidebarProvider>
          <Outlet />
        </SidebarProvider>
      ),
    }),
  };
});
vi.mock("../../routes/_chat", async () => {
  const { createFileRoute, Outlet } = await import("@tanstack/react-router");
  return { Route: createFileRoute("/_chat")({ component: Outlet }) };
});
vi.mock("../../routes/_chat.index", async () => {
  const { createFileRoute } = await import("@tanstack/react-router");
  return { Route: createFileRoute("/_chat/")({ component: () => <h1>Home view</h1> }) };
});

async function openSettingsFromHome() {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultErrorComponent: ({ error }) => <p role="alert">{error.message}</p>,
  });
  await router.load();
  const stopTracking = startMainAppLocationTracking(router);
  // The test renders the real route tree itself, so the default test router stays off.
  const screen = await render(<RouterProvider router={router} />, { router: false });
  await expect.element(page.getByRole("heading", { name: "Home view" })).toBeVisible();
  await router.navigate({ to: "/settings/general" });
  return {
    router,
    async [Symbol.asyncDispose]() {
      stopTracking();
      await screen[Symbol.asyncDispose]();
    },
  };
}

it("shows Settings as a full page in place of the main view, not a modal over it", async () => {
  await using _settings = await openSettingsFromHome();
  await expect.element(page.getByRole("navigation", { name: "Settings breadcrumb" })).toBeVisible();
  expect(page.getByRole("dialog").elements()).toEqual([]);
  expect(page.getByRole("heading", { name: "Home view" }).elements()).toEqual([]);
});

it("returns to the page that opened Settings from the close button", async () => {
  await using settings = await openSettingsFromHome();
  await userEvent.click(page.getByRole("button", { name: "Close settings" }));
  await expect.element(page.getByRole("heading", { name: "Home view" })).toBeVisible();
  expect(settings.router.state.location.pathname).toBe("/");
});

it("returns to the page that opened Settings on Escape", async () => {
  await using settings = await openSettingsFromHome();
  await expect.element(page.getByRole("navigation", { name: "Settings breadcrumb" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("heading", { name: "Home view" })).toBeVisible();
  expect(settings.router.state.location.pathname).toBe("/");
});
