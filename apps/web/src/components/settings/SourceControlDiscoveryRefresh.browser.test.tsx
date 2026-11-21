import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../../test/render";

const state = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { environmentIds: ["env"] },
    environment: { environmentId: "env", label: "Test", connection: { phase: "connected" } },
    connectedEnvironments: [],
  }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { versionControlSystems: [], sourceControlProviders: [] },
    isPending: false,
    error: null,
    refresh: state.refresh,
  }),
}));
vi.mock("../../state/sourceControl", () => ({
  sourceControlEnvironment: { discovery: () => ({}) },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { updateSettings: { permissionAtom: () => null } },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./ProjectDefaultsSettings", () => ({ ProjectDefaultsSettings: () => null }));
vi.mock("./SourceControlWritingSettings", () => ({
  SourceControlWritingSettingsSection: () => null,
}));
vi.mock("./SourceControlHostSettings", () => ({ SourceControlHostSettings: () => null }));
vi.mock("./SourceControlAccountSettings", () => ({ SourceControlAccountSettings: () => null }));
vi.mock("./SourceControlTokenSettings", () => ({ SourceControlTokenSettings: () => null }));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => null,
  useUpdateScopedSettings: () => vi.fn(),
}));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SettingsSearchTarget: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PolicyTooltip: () => null,
  SettingResetButton: () => null,
  useSettingsSearchTargetId: () => undefined,
}));

import { SourceControlSettingsPanel } from "./SourceControlSettings";

it("refreshes discovery on return without a periodic CLI scan", async () => {
  state.refresh.mockReset();
  using _timers = fakeTimers({ now: 1_000_000 });
  // The settings panel does not navigate in this test.
  await using _screen = await render(<SourceControlSettingsPanel />, { router: false });
  await act(() => vi.advanceTimersByTime(10_000));
  await act(() => window.dispatchEvent(new Event("focus")));
  expect(state.refresh).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTime(5 * 60_000));
  expect(state.refresh).toHaveBeenCalledTimes(1);
});
