import { EnvironmentId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { AlertDialog, AlertDialogPopup } from "../ui/alert-dialog";
import { UpdateDialogView } from "./UpdateEverythingDialog";
import { buildAppTab, buildRuntimesTab } from "./updateEverything.logic";
import "~/index.css";

const id = (value: string) => EnvironmentId.make(value);
const nightly = (n: number) => `0.0.${n}-nightly.202610${n - 208}.1`;

const app = buildAppTab({
  local: {
    environmentId: id("this-mac"),
    currentVersion: nightly(228),
    version: nightly(231),
    channel: "nightly",
  },
  servers: [
    {
      environmentId: id("mac-studio"),
      serverLabel: "mac-studio",
      selfUpdate: "boot-service",
      targetVersion: nightly(231),
      fromVersion: nightly(228),
    },
    {
      environmentId: id("windows-mini"),
      serverLabel: "win-mini",
      selfUpdate: "desktop-managed",
      targetVersion: nightly(231),
      fromVersion: nightly(229),
    },
  ],
  sshRuntimes: [
    {
      environmentId: id("build"),
      label: "build-box",
      target: { alias: "build", hostname: "build.local", username: "dev", port: 22 },
      fromVersion: nightly(228),
      targetVersion: nightly(231),
    },
  ],
  skipped: [
    { environmentId: id("offline"), label: "offline-vm", reason: "not connected" },
    { environmentId: id("lab-vm"), label: "lab-vm", reason: "on the stable channel" },
  ],
  runningThreads: (environmentId) => (environmentId === "mac-studio" ? 2 : 0),
});

const runtimes = buildRuntimesTab({
  providerMachines: [
    { environmentId: id("this-mac"), label: "This Mac", providers: ["Claude"] },
    { environmentId: id("ci"), label: "ci-server", providers: ["Codex", "Claude"] },
  ],
  opencodex: {
    environmentId: id("this-mac"),
    status: {
      checkedAt: 0,
      decision: "wait",
      reason: "busy",
      targetVersion: "2.91.0",
      waitingOn: ["mac-studio"],
      advisories: [],
      members: [],
    },
    canCheck: true,
  },
});

async function renderDialog(onConfirm = vi.fn()) {
  const screen = await render(
    <AlertDialog open>
      <AlertDialogPopup className="sm:max-w-xl">
        <UpdateDialogView app={app} runtimes={runtimes} onConfirm={onConfirm} />
      </AlertDialogPopup>
    </AlertDialog>,
    // The dialog renders no links and reads no route.
    { router: false },
  );
  return { screen, onConfirm };
}

it("follows the active tab and the checked rows", async () => {
  const { screen, onConfirm } = await renderDialog();
  await using _screen = screen;

  await expect
    .element(page.getByRole("tab", { name: "App & servers 4" }))
    .toHaveAttribute("aria-selected", "true");
  await expect.element(page.getByRole("button", { name: "Update 4" })).toBeVisible();
  await expect.element(page.getByText("waits for idle")).toBeVisible();
  await expect.element(page.getByText("offline-vm: not connected")).toBeVisible();

  await userEvent.click(page.getByRole("checkbox", { name: /mac-studio/ }));
  await expect.element(page.getByRole("button", { name: "Update 3" })).toBeVisible();

  await userEvent.click(page.getByRole("tab", { name: /Runtimes/ }));
  await expect.element(page.getByRole("button", { name: "Update 3" })).toBeVisible();
  await expect
    .element(page.getByText("Home first, then Children · waits for mac-studio"))
    .toBeVisible();

  await userEvent.click(page.getByRole("checkbox", { name: /ci-server/ }));
  await userEvent.click(page.getByRole("button", { name: "Update 2" }));
  expect(onConfirm).toHaveBeenCalledWith({
    tab: "runtimes",
    rows: [
      expect.objectContaining({ id: "providers:this-mac" }),
      expect.objectContaining({ id: "opencodex" }),
    ],
  });

  // Returning to the first tab keeps what was unchecked there.
  await userEvent.click(page.getByRole("tab", { name: /App & servers/ }));
  await expect.element(page.getByRole("button", { name: "Update 3" })).toBeVisible();
});

it.each([
  ["light", 1280, "App & servers"],
  ["light", 360, "App & servers"],
  ["light", 1280, "Runtimes"],
  ["dark", 1280, "App & servers"],
  ["dark", 360, "App & servers"],
  ["dark", 1280, "Runtimes"],
] as const)("captures the %s theme at %ipx on the %s tab", async (theme, width, tab) => {
  const directory: unknown = import.meta.env.VITE_UPDATE_DIALOG_CAPTURE_DIRECTORY;
  if (typeof directory !== "string" || !directory.startsWith("/")) return;
  document.documentElement.classList.add(theme);
  using _theme = {
    [Symbol.dispose]: () => document.documentElement.classList.remove(theme),
  };
  await page.viewport(width, 820);
  const { screen } = await renderDialog();
  await using _screen = screen;
  await userEvent.click(page.getByRole("tab", { name: new RegExp(tab) }));
  await expect
    .element(page.getByRole("tab", { name: new RegExp(tab) }))
    .toHaveAttribute("aria-selected", "true");
  await document.fonts.ready;
  const slug = tab === "Runtimes" ? "runtimes" : "app";
  await page.screenshot({ path: `${directory}/after-${slug}-${theme}-${width}.png` });
});
