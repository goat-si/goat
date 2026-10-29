import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { routeTree } from "../../routeTree.gen";
import { startMainAppLocationTracking } from "../sidebar/mainAppLocation";
import "../../index.css";

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

const SETTINGS_LAYOUT_ID = "/_chat/settings";
const SHOW_BOT_THREADS_KEY = "goat:sidebar:show-bot-threads";

function withoutStoredBotThreadsChoice() {
  const saved = localStorage.getItem(SHOW_BOT_THREADS_KEY);
  localStorage.removeItem(SHOW_BOT_THREADS_KEY);
  return {
    [Symbol.dispose]: () =>
      saved === null
        ? localStorage.removeItem(SHOW_BOT_THREADS_KEY)
        : localStorage.setItem(SHOW_BOT_THREADS_KEY, saved),
  };
}

async function openSettings(url: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [url] }),
    defaultErrorComponent: ({ error }) => <p role="alert">{error.message}</p>,
  });
  await router.load();
  // The test renders the real route tree itself, so the default test router stays off.
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
  await expect.element(page.getByText("Choose a device")).toBeVisible();
  expect(page.getByRole("alert").elements()).toEqual([]);
});

it("keeps a Memory deep link's target through the settings layout's search handling", async () => {
  const { screen, router } = await openSettings(
    "/settings/memory?environmentId=env-a&memorySpaceId=space-1&memoryId=memory-1",
  );
  await using _screen = screen;
  await expect.element(page.getByText("Memory unavailable")).toBeVisible();
  expect(router.state.location.search).toMatchObject({
    environmentId: "env-a",
    memorySpaceId: "space-1",
    memoryId: "memory-1",
  });
});

it("brings GOAT Bot threads back from General > Sidebar and remembers the choice on this device", async () => {
  using _choice = withoutStoredBotThreadsChoice();
  const { screen } = await openSettings("/settings/general");
  await using _screen = screen;
  const reveal = page.getByRole("switch", { name: "Show GOAT Bot threads" });
  await expect.element(reveal).not.toBeChecked();

  await userEvent.click(reveal);
  await expect.element(reveal).toBeChecked();
  expect(localStorage.getItem(SHOW_BOT_THREADS_KEY)).toBe("true");

  await userEvent.click(reveal);
  await expect.element(reveal).not.toBeChecked();
  expect(localStorage.getItem(SHOW_BOT_THREADS_KEY)).toBe("false");
});

async function openSettingsFromHome() {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultErrorComponent: ({ error }) => <p role="alert">{error.message}</p>,
  });
  await router.load();
  await using stack = new AsyncDisposableStack();
  stack.defer(startMainAppLocationTracking(router));
  stack.use(await render(<RouterProvider router={router} />, { router: false }));
  await expect.element(page.getByRole("heading", { name: "Home view" })).toBeVisible();
  await router.navigate({ to: "/settings/general" });
  const owned = stack.move();
  return { router, [Symbol.asyncDispose]: () => owned.disposeAsync() };
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
