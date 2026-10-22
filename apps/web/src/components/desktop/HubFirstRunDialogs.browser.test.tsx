import { expect, it, vi } from "vite-plus/test";
import { type Locator, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { GoatclawFirstRunDialog, OpenCodexFirstRunDialog } from "./HubFirstRunDialogs";

// The dialog's opening transition keeps Playwright's actionability check waiting, so press
// through the DOM the way CuaSetupDialog's tests do.
async function press(locator: Locator) {
  await expect.element(locator).toBeInTheDocument();
  await act(() => (locator.element() as HTMLElement).click());
}

const profileIds = ["observer", "worker", "manager", "merge-manager", "owner"];

it("answers the OpenCodex question with Connect or standalone, and closing is later", async () => {
  const onClose = vi.fn();
  await using screen = await render(
    <OpenCodexFirstRunDialog
      hostLabel="this Mac"
      situation={{ kind: "linked", homeName: "jun-mbp" }}
      onClose={onClose}
    />,
  );
  await expect.element(screen.getByText(/linked to the Home on jun-mbp/)).toBeVisible();
  await press(screen.getByRole("button", { name: "Connect" }));
  await press(screen.getByRole("button", { name: "Run standalone" }));
  await userEvent.keyboard("{Escape}");
  expect(onClose.mock.calls).toEqual([["connect"], ["standalone"], ["later"]]);
});

it("turns on only what was switched on, with the chosen default profile", async () => {
  const onTurnOn = vi.fn(async () => null);
  const onClose = vi.fn();
  await using screen = await render(
    <GoatclawFirstRunDialog
      hostLabel="this Mac"
      situation={{ kind: "home", devices: 2 }}
      profileIds={profileIds}
      defaultProfile="worker"
      onTurnOn={onTurnOn}
      onClose={onClose}
    />,
  );
  await expect
    .element(screen.getByText(/This Mac is the OpenCodex Home for 2 devices/))
    .toBeVisible();
  const turnOn = screen.getByRole("button", { name: "Turn on" });
  const profile = screen.getByRole("combobox", { name: "Default profile" });
  await expect.element(turnOn).toBeDisabled();
  await expect.element(profile).toBeDisabled();
  await press(screen.getByRole("switch", { name: "Permission profiles" }));
  await press(profile);
  await press(screen.getByRole("option", { name: "Merge manager" }));
  await press(turnOn);
  expect(onTurnOn).toHaveBeenCalledWith({
    hub: false,
    profiles: true,
    defaultProfile: "merge-manager",
  });
  expect(onClose).toHaveBeenCalledWith("answered");
});

it("keeps the goatclaw dialog open with the error when saving fails, and Keep off answers it", async () => {
  const onClose = vi.fn();
  await using screen = await render(
    <GoatclawFirstRunDialog
      hostLabel="this Mac"
      situation={{ kind: "unlinked" }}
      profileIds={profileIds}
      defaultProfile="worker"
      onTurnOn={async () => "Could not save. Try again."}
      onClose={onClose}
    />,
  );
  await press(screen.getByRole("switch", { name: "This machine is the hub" }));
  await press(screen.getByRole("button", { name: "Turn on" }));
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Could not save. Try again.");
  expect(onClose).not.toHaveBeenCalled();
  await press(screen.getByRole("button", { name: "Keep off" }));
  expect(onClose).toHaveBeenCalledWith("answered");
});
