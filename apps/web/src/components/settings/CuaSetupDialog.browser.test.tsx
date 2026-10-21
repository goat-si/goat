import type { CuaHostStatus, DesktopCuaVerification } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { CuaSetupDialog } from "./CuaSetupDialog";
import type { CuaPermission } from "./CuaSetupDialog.logic";

const mac: CuaHostStatus = { platform: "darwin", running: false };

function fixture() {
  const grants = { accessibility: false, "screen-recording": false };
  return {
    onCheck: vi.fn((permission: CuaPermission) => Promise.resolve(grants[permission])),
    onAllow: vi.fn(async (permission: CuaPermission) => {
      grants[permission] = true;
    }),
    onEnable: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
    onVerify: vi.fn<() => Promise<DesktopCuaVerification>>(),
    onClose: vi.fn<(outcome: "enabled" | "dismissed") => void>(),
  };
}

function dialog(
  f: ReturnType<typeof fixture>,
  props: { status?: CuaHostStatus; localMac?: boolean } = {},
) {
  return render(
    <CuaSetupDialog
      enabled={false}
      hostLabel="this Mac"
      status={props.status ?? mac}
      localMac={props.localMac ?? true}
      onCheck={f.onCheck}
      onAllow={f.onAllow}
      onEnable={f.onEnable}
      onVerify={f.onVerify}
      onClose={f.onClose}
    />,
    { router: false },
  );
}

// The dialog renders in a portal, so it is read from the document body.
const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
async function click(label: string) {
  const target = button(label);
  expect(target, label).toBeDefined();
  await act(() => target!.click());
}
const rows = () =>
  [...document.body.querySelectorAll('[aria-label="Permission check"] li')].map(
    (row) => row.textContent,
  );
// Each allow refreshes the grants through window focus, the way returning from System Settings does.
async function allowAll() {
  for (const label of ["Allow", "Allow"]) {
    await click(label);
    await act(() => window.dispatchEvent(new Event("focus")));
  }
}

it("turns on only after both grants, then reports the step that failed and retries the check", async () => {
  const f = fixture();
  f.onVerify.mockResolvedValueOnce({
    verified: false,
    steps: [
      { id: "grants", ok: true },
      { id: "restart", ok: true },
      { id: "permissions", ok: true },
      { id: "identity", ok: true },
      {
        id: "capture",
        ok: false,
        detail: "The screen is locked. Unlock this Mac, then try again.",
      },
    ],
  });
  await using _screen = await dialog(f);
  expect(button("Turn on")?.disabled).toBe(true);
  await allowAll();
  expect(f.onAllow.mock.calls.map(([permission]) => permission)).toEqual([
    "accessibility",
    "screen-recording",
  ]);
  expect(button("Turn on")?.disabled).toBe(false);

  await click("Turn on");
  expect(f.onEnable).toHaveBeenCalledTimes(1);
  expect(f.onVerify).toHaveBeenCalledTimes(1);
  expect(rows()).toEqual([
    "Permissions allowed for GOAT (passed)",
    "Computer use restarted with them (passed)",
    "Computer use sees both permissions (passed)",
    "Computer use runs inside GOAT (passed)",
    "Captured a GOAT window (failed)The screen is locked. Unlock this Mac, then try again.",
    "Read the window's controls (not checked)",
  ]);
  // The setting is already on, so a failed check offers Close, never Later.
  expect(button("Later")).toBeUndefined();

  f.onVerify.mockResolvedValueOnce({
    verified: true,
    steps: (
      ["grants", "restart", "permissions", "identity", "capture", "accessibility"] as const
    ).map((id) => ({ id, ok: true })),
  });
  await click("Try again");
  expect(f.onEnable).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain("Computer use is ready");
  await click("Done");
  expect(f.onClose).toHaveBeenCalledWith("enabled");
});

it("leaves computer use off when the person chooses Later", async () => {
  const f = fixture();
  await using _screen = await dialog(f);
  await click("Later");
  expect(f.onEnable).not.toHaveBeenCalled();
  expect(f.onClose).toHaveBeenCalledWith("dismissed");
});

it("shows a failed save and does not check a driver that was never turned on", async () => {
  const f = fixture();
  f.onEnable.mockResolvedValueOnce("This connection cannot change settings on this host.");
  await using _screen = await dialog(f);
  await allowAll();
  await click("Turn on");
  expect(document.body.textContent).toContain(
    "This connection cannot change settings on this host.",
  );
  expect(f.onVerify).not.toHaveBeenCalled();
  expect(button("Later")).toBeDefined();
});

it("explains a remote Wayland host's needs and turns on without macOS checks", async () => {
  const f = fixture();
  await using _screen = await dialog(f, {
    status: { platform: "linux", running: false, wayland: true },
    localMac: false,
  });
  expect(document.body.textContent).toContain("needs a signed-in graphical session");
  expect(document.body.textContent).toContain("Wayland");
  expect(button("Allow")).toBeUndefined();
  await click("Turn on");
  expect(f.onEnable).toHaveBeenCalledTimes(1);
  expect(f.onVerify).not.toHaveBeenCalled();
  expect(f.onCheck).not.toHaveBeenCalled();
  expect(f.onClose).toHaveBeenCalledWith("enabled");
});
