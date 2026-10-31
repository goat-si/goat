import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ removed: vi.fn(), updated: vi.fn() }));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    environment: {
      environmentId: "env:settings",
      label: "Host",
      connection: { phase: "connected" },
      serverConfig: {},
      entry: { target: { _tag: "PrimaryConnectionTarget" } },
    },
    search: {},
  })) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: ((
    _id: unknown,
    select: (settings: typeof DEFAULT_SERVER_SETTINGS) => unknown,
  ) => select({ ...DEFAULT_SERVER_SETTINGS, cuaAllowedApps: ["A", "B"] })) as never,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: null,
    error: null,
    isPending: false,
    refresh: () => {},
  })) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const permission = Atom.make(true);
  return {
    ...actual,
    serverEnvironment: {
      updateSettings: { id: "update", permissionAtom: () => permission },
      removeComputerUseAllowedApp: { id: "remove", permissionAtom: () => permission },
      computerUse: () => permission,
    },
  } as never;
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { id: string }) =>
    command.id === "remove" ? state.removed : state.updated) as never,
}));
vi.mock(import("./ComputerUsePanel"), async (original) => ({
  ...(await original()),
  ComputerUsePanel: () => <div />,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsSection: (({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  )) as never,
  SettingsRow: (({ title, children }: { title: React.ReactNode; children: React.ReactNode }) => (
    <div>
      <h3>{title}</h3>
      {children}
    </div>
  )) as never,
}));
import { ComputerUseSettings } from "./ComputerUseSettings";

it("removes each selected app by identity even when the displayed list is stale", async () => {
  state.removed.mockReset().mockResolvedValue({ _tag: "Success" });
  state.updated.mockReset();
  await using _screen = await render(<ComputerUseSettings />);
  const buttons = page.getByRole("button", { name: "Remove" });
  await userEvent.click(buttons.nth(0));
  await expect.element(buttons.nth(1)).toBeEnabled();
  await userEvent.click(buttons.nth(1));
  expect(state.removed.mock.calls.map(([arg]) => arg)).toEqual([
    { environmentId: EnvironmentId.make("env:settings"), input: { app: "A" } },
    { environmentId: EnvironmentId.make("env:settings"), input: { app: "B" } },
  ]);
  expect(state.updated).not.toHaveBeenCalled();
});
