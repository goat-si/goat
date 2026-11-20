import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { compileResolvedKeybindingsConfig } from "@goat/shared/keybindings";

const state = vi.hoisted(() => ({ bindings: [] as readonly unknown[], mutate: vi.fn() }));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: ((environments: ReadonlyArray<{ environmentId: string }>) =>
    new Set(environments.map(({ environmentId }) => environmentId))) as never,
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.mutate) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => {
    const environment = {
      environmentId: "env",
      label: "Test",
      serverConfig: {
        keybindings: state.bindings,
        keybindingsConfigPath: null,
        availableEditors: [],
      },
    };
    return {
      scope: { kind: "environment" },
      environment,
      environments: [environment],
      connectedEnvironments: [environment],
      targets: [],
      target: null,
    };
  }) as never,
}));
import { KeybindingsSettingsPanel } from "./KeybindingsSettings";

it("offers unassign for a default shortcut", async () => {
  state.bindings = [];
  state.mutate.mockReset().mockResolvedValue({ _tag: "Success", value: [] });
  await using screen = await render(<KeybindingsSettingsPanel />);
  await userEvent.click(screen.getByRole("button", { name: "Actions for Sidebar: Toggle" }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Unassign" }));
  expect(state.mutate).toHaveBeenCalledWith({
    environmentId: "env",
    input: {
      command: "sidebar.toggle",
      key: "mod+b",
      when: "false",
      replace: { command: "sidebar.toggle", key: "mod+b" },
    },
  });
});

it("restores the default condition when assigning a disabled shortcut", async () => {
  state.bindings = compileResolvedKeybindingsConfig([
    { command: "composer.sendBackground", key: "mod+alt+enter", when: "false" },
  ]);
  state.mutate.mockReset().mockResolvedValue({ _tag: "Success", value: [] });
  await using screen = await render(<KeybindingsSettingsPanel />);
  const unassigned = screen.getByRole("button", {
    name: "Edit shortcut for Composer: Start in Background: Unassigned",
  });
  await userEvent.click(unassigned);
  await userEvent.keyboard("{Control>}{Alt>}j{/Alt}{/Control}");
  await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
  expect(state.mutate).toHaveBeenCalledWith({
    environmentId: "env",
    input: expect.objectContaining({
      command: "composer.sendBackground",
      when: "composerFocus && draftThreadRoute",
      replace: { command: "composer.sendBackground", key: "mod+alt+enter", when: "false" },
    }),
  });
});

it("offers reset for an unassigned default shortcut", async () => {
  state.bindings = compileResolvedKeybindingsConfig([
    { command: "composer.sendBackground", key: "mod+alt+enter", when: "false" },
  ]);
  state.mutate.mockReset().mockResolvedValue({ _tag: "Success", value: [] });
  await using screen = await render(<KeybindingsSettingsPanel />);
  await userEvent.click(
    screen.getByRole("button", { name: "Actions for Composer: Start in Background" }),
  );
  await userEvent.click(screen.getByRole("menuitem", { name: "Reset to default" }));
  expect(state.mutate).toHaveBeenCalledWith({
    environmentId: "env",
    input: {
      command: "composer.sendBackground",
      key: "mod+alt+enter",
      when: "composerFocus && draftThreadRoute",
      replace: { command: "composer.sendBackground", key: "mod+alt+enter", when: "false" },
    },
  });
});
