import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type HubDeviceRoutesResult } from "@goat/contracts";
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";

const state = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn() }));
vi.mock("~/state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = () => Atom.make(true);
  return {
    serverEnvironment: {
      listHubDeviceRoutes: { label: "hub:routes", run: state.list, permissionAtom: allowed },
      updateHubDeviceRoutes: {
        label: "hub:routes-update",
        run: state.update,
        permissionAtom: allowed,
      },
    },
  };
});

import { HubDeviceRoutes } from "./HubDeviceRoutes";

const listed = (routes: ReadonlyArray<string>) => ({
  _tag: "Success" as const,
  value: {
    deviceAlias: "mini",
    state: "ok",
    message: `mini has ${routes.length} route(s).`,
    linkId: "lnk_0123456789abcdef",
    pin: "mini",
    routes,
  } satisfies HubDeviceRoutesResult,
});

it("a change the Home stored but could not apply keeps saying so after the list is read back", async () => {
  state.list.mockReset().mockResolvedValueOnce(listed(["mini", "pen-mini"]));
  state.update.mockReset().mockResolvedValueOnce({
    _tag: "Success",
    value: {
      deviceAlias: "mini",
      state: "ok",
      code: "routes_stored_reload_failed",
      message:
        "The change was stored, but the Home could not apply it yet; it applies once OpenCodex restarts there.",
      linkId: "lnk_0123456789abcdef",
    } satisfies HubDeviceRoutesResult,
  });
  const registry = AtomRegistry.make();
  await using screen = await render(
    <RegistryContext value={registry}>
      <HubDeviceRoutes environmentId={EnvironmentId.make("hub")} alias="mini" />
    </RegistryContext>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Routes" }));
  await expect.element(screen.getByText("pen-mini")).toBeVisible();
  state.list.mockResolvedValueOnce(listed(["mini-lan", "mini", "pen-mini"]));
  await userEvent.fill(screen.getByRole("textbox", { name: "New route for mini" }), "mini-lan");
  await userEvent.click(screen.getByRole("button", { name: "Add route" }));
  await expect.element(screen.getByText("mini-lan")).toBeVisible();
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent(
      "The change was stored, but the Home could not apply it yet; it applies once OpenCodex restarts there.",
    );
  registry.dispose();
});
