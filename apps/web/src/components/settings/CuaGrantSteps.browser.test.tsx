import type { ComputerUseReadiness as Readiness } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { ComputerUseReadiness } from "../computerUse/ComputerUseReadiness";
import { cuaReadinessGrantSlot } from "./CuaGrantSteps";
import type { CuaGrantHolder, CuaPermission } from "./CuaSetupDialog.logic";

const reported: Readiness = {
  grants: { accessibility: "denied", screenCapture: "unknown" },
  helper: "authenticated",
  capture: "pending",
  tree: "unavailable",
  input: "unavailable",
  blockers: [],
  reasons: [],
};
const live = (accessibility: boolean, screenRecording: boolean): CuaGrantHolder => ({
  principal: "helper",
  name: "GOAT Computer Use",
  bundleId: "si.goat.desktop.computer-use",
  accessibility,
  screenRecording,
});

function readiness(slot: ReturnType<typeof cuaReadinessGrantSlot>) {
  // A presentational list: no route reads it.
  return render(
    <ComputerUseReadiness
      platform="darwin"
      readiness={reported}
      tools="available"
      renderGrantAction={slot}
    />,
    { router: false },
  );
}
const buttons = () =>
  [...document.body.querySelectorAll("button")].map((node) => node.textContent?.trim());

it("offers the System Settings guide only for the grant to do now, and opens its pane", async () => {
  const onOpen = vi.fn<(permission: CuaPermission) => void>();
  await using screen = await readiness(
    cuaReadinessGrantSlot({ live: live(false, false), opened: null, busy: false, onOpen }),
  );
  expect(buttons()).toEqual(["Open Settings"]);
  await screen.getByRole("button", { name: "Open Settings" }).click();
  expect(onOpen).toHaveBeenCalledWith("accessibility");
});

it("shows the re-drag hint while the pane is open, and no ask for a grant this Mac reads as on", async () => {
  await using screen = await readiness(
    cuaReadinessGrantSlot({
      live: live(false, true),
      opened: "accessibility",
      busy: false,
      onOpen: vi.fn(),
    }),
  );
  await expect.element(screen.getByRole("button", { name: "Open again" })).toBeVisible();
  await expect
    .element(screen.getByText(/Already on\? Remove it with the − button and drag it in again\./))
    .toBeVisible();
  // Screen recording is not reported granted yet, but this Mac already reads it as on.
  await expect.element(screen.getByText("Allowed on this Mac")).toBeVisible();
  expect(buttons()).toEqual(["Open again"]);
});
