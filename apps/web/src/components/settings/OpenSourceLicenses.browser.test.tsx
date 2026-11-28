import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render, stubGlobal } from "../../../test/render";
import { OpenSourceLicensesPanel } from "./OpenSourceLicenses";
import { SettingsPageShell } from "./SettingsPageShell";

it("Esc in the license search closes it without closing Settings", async () => {
  const entry = {
    bundles: ["web"],
    kind: "package",
    license: "MIT",
    name: "react",
    noticeText: "MIT License",
    sourceUrl: null,
    version: "19.0.0",
  };
  const realFetch = globalThis.fetch.bind(globalThis);
  using _fetch = stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    (input instanceof Request ? input.url : String(input)).endsWith("/third-party-licenses.json")
      ? Promise.resolve(Response.json({ schemaVersion: 1, entries: [entry] }))
      : realFetch(input, init),
  );
  const root = createRootRoute({ component: Outlet });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/settings/open-source-licenses",
    component: () => (
      <SettingsPageShell pathname="/settings/open-source-licenses">
        <OpenSourceLicensesPanel />
      </SettingsPageShell>
    ),
  });
  const home = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <h1>Home view</h1>,
  });
  const router = createRouter({
    routeTree: root.addChildren([settings, home]),
    history: createMemoryHistory({ initialEntries: ["/settings/open-source-licenses"] }),
    disableGlobalCatchBoundary: true,
  });
  await router.load();
  // Uses a custom multi-route router with SettingsPageShell and a home fallback route.
  await using _screen = await render(<RouterProvider router={router} />, { router: false });
  const closeSettings = page.getByRole("button", { name: "Close settings" });
  const search = page.getByRole("searchbox", { name: "Search open-source licenses" });
  const openSearch = async () => {
    const button = page.getByRole("button", { name: "Search open-source licenses" });
    await expect.element(button).toBeVisible();
    (button.element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(search).toHaveFocus();
  };
  await openSearch();
  await search.fill("react");

  await userEvent.keyboard("{Escape}");

  await expect.element(closeSettings).toBeVisible();
  await expect.element(search).not.toBeInTheDocument();

  await openSearch();
  await expect.element(search).toHaveValue("");
  await userEvent.keyboard("{Escape}");

  await expect.element(closeSettings).toBeVisible();
  await expect.element(search).not.toBeInTheDocument();

  await userEvent.keyboard("{Escape}");

  await expect.element(page.getByRole("heading", { name: "Home view" })).toBeVisible();
});
