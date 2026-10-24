import { RegistryProvider } from "@effect/atom-react";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { deferred, materialBridge, materialState } from "../../../test/windowMaterial";
import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
} from "../../hooks/useSettings";
import { DesktopWindowMaterialSetting } from "./DesktopWindowMaterialSetting";
import "../../index.css";

vi.mock("./SettingsScopeContext", () => ({
  useOptionalSettingsScope: () => null,
  useSettingsScope: () => ({
    target: null,
    targets: [],
    environments: [],
    scope: { kind: "all", label: "All environments", members: [], environmentIds: [] },
  }),
}));

// Environment RPC is outside this client-only setting's persistence path.
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));
// The production row also subscribes to server permissions unrelated to a device preference.
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    title: string;
    description: string;
    control: import("react").ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
      {control}
    </div>
  ),
}));

function Setting() {
  return (
    <RegistryProvider>
      <DesktopWindowMaterialSetting />
    </RegistryProvider>
  );
}

it("persists System glass through the client patch queue and rehydrates the saved choice", async () => {
  using fixture = materialBridge();
  await using screen = await render(<Setting />);
  const toggle = screen.getByRole("switch", { name: "System glass" });
  await expect.element(toggle).toBeEnabled();
  await toggle.click();
  await expect.element(toggle).toBeChecked();
  await vi.waitFor(() => expect(fixture.saved().desktopSystemMaterialEnabled).toBe(true));
  await screen.rerender(<></>);
  __resetClientSettingsPersistenceForTests();
  await screen.rerender(<Setting />);
  await expect.element(screen.getByRole("switch", { name: "System glass" })).toBeChecked();
  await expect.element(screen.getByText("Using Mica.")).toBeVisible();
});

it("rolls the switch back when the desktop settings write is rejected", async () => {
  using fixture = materialBridge();
  const write = deferred<void>();
  fixture.bridge.setClientSettings.mockReturnValueOnce(write.promise);
  await using screen = await render(<Setting />);
  using _log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const toggle = screen.getByRole("switch", { name: "System glass" });
  await expect.element(toggle).toBeEnabled();
  await toggle.click();
  await expect.element(toggle).toBeChecked();
  await act(async () => {
    write.reject(new Error("disk unavailable"));
    await write.promise.catch(() => undefined);
  });
  await expect.element(toggle).not.toBeChecked();
  expect(fixture.saved().desktopSystemMaterialEnabled).toBe(false);
});

it.each([
  {
    platform: "darwin",
    reason: "api-unavailable" as const,
    copy: "Native glass is not available on macOS in this build.",
  },
  { platform: "win32", reason: "os-version" as const, copy: "Requires Windows 11 22H2 or later." },
])(
  "shows the saved preference and unsupported status on $platform",
  async ({ platform, reason, copy }) => {
    using fixture = materialBridge(
      materialState({
        capability: { supported: false, reason },
        applied: "none",
        reason: "unsupported",
      }),
      platform,
    );
    await fixture.bridge.setClientSettings({
      ...fixture.saved(),
      desktopSystemMaterialEnabled: true,
    });
    await ensureClientSettingsHydrated();
    await using screen = await render(<Setting />);
    const toggle = screen.getByRole("switch", { name: "System glass" });
    await expect.element(toggle).toBeDisabled();
    await expect.element(toggle).toBeChecked();
    await expect.element(screen.getByText(copy)).toBeVisible();
  },
);

it.each(["browser", "older desktop"])(
  "hides the setting in an %s without material IPC",
  async (client) => {
    using _fixture = materialBridge();
    if (client === "browser") delete window.desktopBridge;
    else if (window.desktopBridge) {
      delete window.desktopBridge.getWindowMaterialState;
      delete window.desktopBridge.onWindowMaterialStateChanged;
    }
    await using screen = await render(<Setting />);
    await expect
      .element(screen.getByRole("switch", { name: "System glass" }))
      .not.toBeInTheDocument();
  },
);

it.each([
  {
    reason: "accessibility" as const,
    copy: "Off while reduced transparency or high contrast is on.",
  },
  { reason: "opaque" as const, copy: "Off at 100% glass opacity." },
  { reason: "fullscreen" as const, copy: "Paused in full screen." },
  { reason: "native-failed" as const, copy: "The system material could not be applied." },
])("explains why system glass is inactive: $reason", async ({ reason, copy }) => {
  using fixture = materialBridge();
  await using screen = await render(<Setting />);
  await act(() => fixture.push(materialState({ revision: 2, applied: "none", reason })));
  await expect.element(screen.getByText(copy)).toBeVisible();
  await expect.element(screen.getByRole("switch", { name: "System glass" })).toBeEnabled();
});
it("labels active macOS glass as a development candidate", async () => {
  using _fixture = materialBridge(
    materialState({
      capability: { supported: true, material: "macos-glass" },
      applied: "macos-glass",
      reason: "active",
    }),
    "darwin",
  );
  await using screen = await render(<Setting />);
  await expect
    .element(screen.getByText("Using system glass (development candidate)."))
    .toBeVisible();
});
