import type { CuaHostStatus, DesktopCuaGrants, DesktopCuaVerification } from "@goat/contracts";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { COMPUTER_USE_ADVANCED_STORAGE_KEY, ComputerUsePanel } from "./ComputerUsePanel";
import type { CuaPermission } from "./CuaSetupDialog.logic";

const state = vi.hoisted(() => ({ searchTargetId: null as string | null }));

// The real row reads write permission and scope from live environment state; this suite is
// about the setup the switch runs and what the status line says.
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  useSettingsSearchTargetId: () => state.searchTargetId,
  SettingsRow: (({
    id,
    title,
    status,
    control,
  }: {
    id?: string;
    title: ReactNode;
    status?: ReactNode;
    control?: ReactNode;
  }) => (
    <div id={id}>
      <h3>{title}</h3>
      {status}
      {control}
    </div>
  )) as never,
}));

const HELPER = {
  principal: "helper",
  name: "GOAT Computer Use",
  bundleId: "si.goat.desktop.computer-use",
} as const;
const PASSED: DesktopCuaVerification = {
  verified: true,
  steps: (
    ["grants", "restart", "permissions", "identity", "capture", "accessibility"] as const
  ).map((id) => ({ id, ok: true })),
};
const idleMac: CuaHostStatus = { platform: "darwin", running: false, tools: "unavailable" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/** A Mac seen through the desktop bridge, and a host whose settings follow each save. */
function setup(options: { granted?: boolean; enabled?: boolean; status?: CuaHostStatus } = {}) {
  state.searchTargetId = null;
  localStorage.removeItem(COMPUTER_USE_ADVANCED_STORAGE_KEY);
  const granted = options.granted ?? true;
  const f = {
    calls: [] as string[],
    grants: { accessibility: granted, screenRecording: granted },
    enabled: options.enabled ?? false,
    localMac: true,
    status: options.status ?? idleMac,
    disabledSkills: [] as string[],
    save: vi.fn(
      async (patch: { enableCua?: boolean; disabledBuiltInSkills?: ReadonlyArray<string> }) => {
        f.calls.push(`save:${JSON.stringify(patch)}`);
        return null as string | null;
      },
    ),
    checkGrants: vi.fn(async (): Promise<DesktopCuaGrants> => {
      f.calls.push("checkGrants");
      return { ...HELPER, ...f.grants };
    }),
    verify: vi.fn(async () => {
      f.calls.push("verify");
      return PASSED;
    }),
    openGuide: vi.fn(async (permission: CuaPermission) => {
      f.calls.push(`open:${permission}`);
    }),
  };
  return f;
}
type Fixture = ReturnType<typeof setup>;

const panel = (f: Fixture) => (
  <ComputerUsePanel
    hostLabel="this Mac"
    enabled={f.enabled}
    canConfigure
    status={f.status}
    error={null}
    localMac={f.localMac}
    disabledSkills={f.disabledSkills}
    fullAccessAutoAdmit={false}
    save={f.save}
    bridge={{ checkGrants: f.checkGrants, verify: f.verify, openGuide: f.openGuide }}
  />
);

const statusText = () => document.querySelector('[role="status"]')?.textContent ?? null;
const buttonLabels = () =>
  [...document.querySelectorAll("button")].map((node) => node.textContent?.trim());
// The switch has no size without the app stylesheet, so it is clicked through the DOM.
const clickSwitch = (name: string) =>
  act(() => document.querySelector<HTMLElement>(`[role="switch"][aria-label="${name}"]`)?.click());
// Coming back from System Settings focuses GOAT, which reads the grants again.
const refocus = () => act(() => window.dispatchEvent(new Event("focus")));

it("turning the switch on saves, reads the grants and verifies the helper in that order", async () => {
  const f = setup();
  const check = deferred<DesktopCuaVerification>();
  f.verify.mockImplementation(async () => {
    f.calls.push("verify");
    return check.promise;
  });
  await using screen = await render(panel(f));
  expect(buttonLabels()).not.toContain("Set up");
  await clickSwitch("Computer use");
  await vi.waitFor(() => expect(f.verify).toHaveBeenCalledOnce());
  expect(statusText()).toBe("Setting up…");
  expect(f.calls.slice(0, 3)).toEqual(['save:{"enableCua":true}', "checkGrants", "verify"]);
  await act(() => check.resolve(PASSED));
  // The verify run stops its own helper, so the tools start with the next turn.
  await vi.waitFor(() => expect(statusText()).toBe("Ready. Starts with the next agent turn."));
  f.enabled = true;
  f.status = { ...idleMac, running: true, tools: "available" };
  await screen.rerender(panel(f));
  await vi.waitFor(() => expect(statusText()).toBe("Ready"));
  // The skill keeps its own setting.
  expect(f.save).not.toHaveBeenCalledWith(
    expect.objectContaining({ disabledBuiltInSkills: expect.anything() }),
  );
});

it("asks for one missing grant at a time and resumes setup once a new read shows it on", async () => {
  const f = setup({ granted: false });
  await using screen = await render(panel(f));
  await clickSwitch("Computer use");
  await vi.waitFor(() =>
    expect(statusText()).toBe("Needs your OK in System Settings: Accessibility"),
  );
  expect(buttonLabels().filter((label) => label?.startsWith("Open"))).toEqual(["Open"]);
  await screen.getByRole("button", { name: "Open: Accessibility in System Settings" }).click();
  expect(f.openGuide).toHaveBeenCalledWith("accessibility");
  await expect
    .element(screen.getByText(/Drag GOAT Computer Use into the list and turn on its switch/))
    .toBeVisible();
  expect(buttonLabels()).toContain("Open again");

  f.grants.accessibility = true;
  await refocus();
  await vi.waitFor(() =>
    expect(statusText()).toBe("Needs your OK in System Settings: Screen & System Audio Recording"),
  );
  expect(f.verify).not.toHaveBeenCalled();

  f.grants.screenRecording = true;
  await refocus();
  await vi.waitFor(() => expect(f.verify).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(statusText()).toMatch(/^Ready/));
});

it("shows Retry setup when the check fails, without opening Advanced, and Retry runs setup again", async () => {
  const f = setup();
  f.verify.mockResolvedValueOnce({
    verified: false,
    steps: [
      { id: "grants", ok: true },
      { id: "restart", ok: true },
      { id: "permissions", ok: true },
      { id: "identity", ok: true },
      { id: "capture", ok: false, detail: "No window to capture." },
    ],
  });
  await using screen = await render(panel(f));
  await clickSwitch("Computer use");
  await vi.waitFor(() => expect(statusText()).toBe("Setup failed: No window to capture."));
  expect(screen.getByText("1. OS grants").query()).toBeNull();
  await screen.getByRole("button", { name: "Retry setup" }).click();
  await vi.waitFor(() => expect(statusText()).toMatch(/^Ready/));
  expect(f.verify).toHaveBeenCalledTimes(2);
});

it("Off while waiting for a grant stops setup, even before the settings catch up", async () => {
  const f = setup({ granted: false });
  await using screen = await render(panel(f));
  const toggle = screen.getByRole("switch", { name: "Computer use" });
  await clickSwitch("Computer use");
  f.enabled = true;
  await screen.rerender(panel(f));
  await vi.waitFor(() => expect(statusText()).toMatch(/^Needs your OK/));
  await clickSwitch("Computer use");
  expect(f.save).toHaveBeenLastCalledWith({ enableCua: false });
  // The settings stream still says on.
  await expect.element(toggle).not.toBeChecked();
  f.grants.accessibility = true;
  f.grants.screenRecording = true;
  await refocus();
  await screen.rerender(panel(f));
  expect(f.verify).not.toHaveBeenCalled();
  expect(statusText()).toBeNull();
});

it("Off while verifying ignores the late result, and On again runs a fresh check", async () => {
  const f = setup();
  const first = deferred<DesktopCuaVerification>();
  f.verify.mockImplementationOnce(() => first.promise);
  await using _screen = await render(panel(f));
  await clickSwitch("Computer use");
  await vi.waitFor(() => expect(f.verify).toHaveBeenCalledOnce());
  await clickSwitch("Computer use");
  await act(() => first.resolve(PASSED));
  expect(statusText() ?? "").not.toMatch(/^Ready/);
  await clickSwitch("Computer use");
  await vi.waitFor(() => expect(f.verify).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(statusText()).toMatch(/^Ready/));
});

it("ignores a grant read that started before setup and lands after setup's own read", async () => {
  const f = setup({ enabled: true, status: { ...idleMac, failure: "Helper could not start." } });
  const stale = deferred<DesktopCuaGrants>();
  f.checkGrants.mockImplementationOnce(() => stale.promise);
  await using screen = await render(panel(f));
  await vi.waitFor(() => expect(f.checkGrants).toHaveBeenCalledOnce());
  await screen.getByRole("button", { name: "Retry setup" }).click();
  await vi.waitFor(() => expect(f.verify).toHaveBeenCalledOnce());
  await act(() => stale.resolve({ ...HELPER, accessibility: false, screenRecording: false }));
  expect(statusText() ?? "").not.toMatch(/^Needs your OK/);
});

it("keeps the grant prompt and does not resume when a read fails", async () => {
  const f = setup({ granted: false });
  await using screen = await render(panel(f));
  await clickSwitch("Computer use");
  await vi.waitFor(() => expect(statusText()).toMatch(/^Needs your OK/));
  f.checkGrants.mockRejectedValue(new Error("helper crashed"));
  await refocus();
  await expect
    .element(screen.getByText("Could not check permissions. We'll try again automatically."))
    .toBeVisible();
  expect(statusText()).toMatch(/^Needs your OK/);
  expect(f.verify).not.toHaveBeenCalled();
});

it("a failure the host reports outranks this session's passing check, even with the same text", async () => {
  const f = setup({ status: { ...idleMac, failure: "Helper could not start." } });
  await using _screen = await render(panel(f));
  await clickSwitch("Computer use");
  await vi.waitFor(() => expect(f.verify).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(statusText()).toBe("Helper could not start."));
  expect(buttonLabels()).toContain("Retry setup");
});

it.each([
  ["an error", async () => "Could not save the setting. Try again."],
  [
    "a rejection",
    async (): Promise<string | null> => {
      throw new Error("socket closed");
    },
  ],
])("Off that fails with %s shows the switch on again and says so", async (_, failure) => {
  const f = setup({ enabled: true });
  await using screen = await render(panel(f));
  f.save.mockImplementationOnce(failure);
  const toggle = screen.getByRole("switch", { name: "Computer use" });
  await clickSwitch("Computer use");
  await expect
    .element(screen.getByText("Could not turn off computer use. Try again."))
    .toBeVisible();
  await expect.element(toggle).toBeChecked();
});

it("tells a remote Mac's person what to grant there, with nothing to open here", async () => {
  const f = setup({
    enabled: true,
    status: {
      platform: "darwin",
      running: false,
      tools: "unavailable",
      readiness: {
        grants: { accessibility: "denied", screenCapture: "granted" },
        helper: "authenticated",
        capture: "ready",
        tree: "unavailable",
        input: "unavailable",
        blockers: [],
        reasons: [],
      },
    },
  });
  f.localMac = false;
  await using _screen = await render(panel(f));
  await vi.waitFor(() =>
    expect(statusText()).toMatch(/^this Mac needs Accessibility and Screen Recording/),
  );
  expect(f.checkGrants).not.toHaveBeenCalled();
  expect(buttonLabels().filter((label) => label?.startsWith("Open"))).toEqual([]);
});

it("keeps the readiness list and skill switch in Advanced, closed by default and remembered", async () => {
  const f = setup({ enabled: true, status: { ...idleMac, running: true, tools: "available" } });
  {
    await using screen = await render(panel(f));
    expect(screen.getByText("1. OS grants").query()).toBeNull();
    expect(screen.getByRole("switch", { name: "Computer Use skill" }).query()).toBeNull();
    await screen.getByRole("button", { name: "Details" }).click();
    await expect.element(screen.getByText("1. OS grants")).toBeVisible();
    expect(localStorage.getItem(COMPUTER_USE_ADVANCED_STORAGE_KEY)).toBe("true");
    await clickSwitch("Computer Use skill");
    expect(f.save).toHaveBeenLastCalledWith({ disabledBuiltInSkills: ["computer-use"] });
  }
  await using screen = await render(panel(f));
  await expect
    .element(screen.getByRole("switch", { name: "Computer Use skill" }))
    .toBeInTheDocument();
  await screen.getByRole("button", { name: "Advanced" }).click();
  expect(localStorage.getItem(COMPUTER_USE_ADVANCED_STORAGE_KEY)).toBe("false");
});

it.each([
  ["computer-use-skill", "Computer Use skill"],
  ["computer-use-full-access", "Full access without approval"],
])("a settings search for %s opens Advanced without remembering it", async (target, name) => {
  const f = setup({ enabled: true });
  state.searchTargetId = target;
  await using screen = await render(panel(f));
  await expect.element(screen.getByRole("switch", { name })).toBeInTheDocument();
  expect(document.getElementById(target)).not.toBeNull();
  expect(localStorage.getItem(COMPUTER_USE_ADVANCED_STORAGE_KEY)).toBeNull();
  await clickSwitch(name);
  expect(f.save).toHaveBeenLastCalledWith(
    target === "computer-use-skill"
      ? { disabledBuiltInSkills: ["computer-use"] }
      : { cuaFullAccessAutoAdmit: true },
  );
});
it("On again while an earlier check still runs waits for it, then checks for the new run", async () => {
  const f = setup();
  const first = deferred<DesktopCuaVerification>();
  f.verify.mockImplementationOnce(() => first.promise);
  await using _screen = await render(panel(f));
  await clickSwitch("Computer use");
  await vi.waitFor(() => expect(f.verify).toHaveBeenCalledOnce());
  await clickSwitch("Computer use");
  await clickSwitch("Computer use");
  await vi.waitFor(() => expect(f.checkGrants).toHaveBeenCalledTimes(2));
  expect(f.verify).toHaveBeenCalledOnce();
  await act(() => first.resolve(PASSED));
  await vi.waitFor(() => expect(f.verify).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(statusText()).toMatch(/^Ready/));
});

it.each([
  [
    "a blocked capture",
    {
      ...idleMac,
      running: true,
      tools: "available",
      readiness: {
        grants: { accessibility: "granted", screenCapture: "granted" },
        helper: "authenticated",
        capture: "blank",
        tree: "ready",
        input: "background",
        blockers: [],
        reasons: [],
      },
    },
  ],
  ["a host failure", { ...idleMac, failure: "Helper could not start." }],
] satisfies ReadonlyArray<[string, CuaHostStatus]>)(
  "%s reported after a passing check ends Ready until a new check passes",
  async (_, rejecting) => {
    const f = setup();
    await using screen = await render(panel(f));
    await clickSwitch("Computer use");
    await vi.waitFor(() => expect(statusText()).toMatch(/^Ready/));
    f.enabled = true;
    f.status = rejecting;
    await screen.rerender(panel(f));
    await vi.waitFor(() => expect(statusText() ?? "").not.toMatch(/^Ready/));
    // The report clears, but nothing has proved the helper again.
    f.status = idleMac;
    await screen.rerender(panel(f));
    await vi.waitFor(() => expect(statusText()).toBe("Starts with the next agent turn"));
  },
);

it("a System Settings pane that cannot open says so and keeps the Open button", async () => {
  const f = setup({ granted: false });
  f.openGuide.mockRejectedValueOnce(new Error("no pane"));
  await using screen = await render(panel(f));
  await clickSwitch("Computer use");
  await vi.waitFor(() => expect(statusText()).toMatch(/^Needs your OK/));
  const open = screen.getByRole("button", { name: "Open: Accessibility in System Settings" });
  await open.click();
  await expect
    .element(screen.getByText("Could not open System Settings. Try again."))
    .toBeVisible();
  await open.click();
  expect(f.openGuide).toHaveBeenCalledTimes(2);
});
