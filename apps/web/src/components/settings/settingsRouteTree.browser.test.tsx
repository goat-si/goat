import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { routeTree } from "../../routeTree.gen";

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

const SETTINGS_LAYOUT_ID = "/_chat/settings";

async function openSettings(url: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [url] }),
    defaultErrorComponent: ({ error }) => <p role="alert">{error.message}</p>,
  });
  await router.load();
  const screen = await render(<RouterProvider router={router} />, { router: false });
  return { screen, router };
}

it("mounts every /settings page under the settings layout that provides its scope", () => {
  const router = createRouter({ routeTree, history: createMemoryHistory() });
  const outsideLayout = Object.values(router.routesById)
    .filter((route) => route.fullPath.startsWith("/settings/"))
    .filter((route) => {
      for (let parent = route.parentRoute; parent; parent = parent.parentRoute) {
        if (parent.id === SETTINGS_LAYOUT_ID) return false;
      }
      return true;
    })
    .map((route) => route.fullPath);
  expect(outsideLayout).toEqual([]);
});

it("opens Memory inside the settings layout instead of the scope provider error", async () => {
  const { screen } = await openSettings("/settings/memory");
  await using _screen = screen;
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect.element(settings.getByText("Choose a device")).toBeVisible();
  expect(page.getByRole("alert").elements()).toEqual([]);
});

it("keeps a Memory deep link's target through the settings layout's search handling", async () => {
  const { screen, router } = await openSettings(
    "/settings/memory?environmentId=env-a&memorySpaceId=space-1&memoryId=memory-1",
  );
  await using _screen = screen;
  await expect
    .element(page.getByRole("dialog", { name: "Settings" }).getByText("Memory unavailable"))
    .toBeVisible();
  expect(router.state.location.search).toMatchObject({
    environmentId: "env-a",
    memorySpaceId: "space-1",
    memoryId: "memory-1",
  });
});
