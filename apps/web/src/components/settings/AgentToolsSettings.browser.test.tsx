import { render } from "../../../test/render";
import { DEFAULT_SERVER_SETTINGS } from "@goat/contracts";
import type { AgentToolListing } from "@goat/contracts/agentSurface/listing";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  settings: {} as typeof DEFAULT_SERVER_SETTINGS,
  mixed: false,
  updateSettings: vi.fn(async () => ({ _tag: "Success" as const, value: undefined })),
}));

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) =>
    command === "updateSettings" ? state.updateSettings : vi.fn()) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      updateSettings: "updateSettings",
    } as unknown as typeof actual.serverEnvironment,
  };
});
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => {
    const environment = {
      environmentId: "env",
      label: "Build workstation",
      connection: { phase: "connected" },
      serverConfig: { settings: state.settings, environment: { capabilities: {} } },
    };
    return {
      scope: { kind: "environment", environmentIds: ["env"] },
      environments: [environment],
      connectedEnvironments: [environment],
      targets: [],
      target: null,
    };
  }) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => state.settings) as never,
  useScopedSettingsMixed: () => state.mixed,
}));
// The real row reads write permission and project overrides from live environment
// state; this suite is about what the control writes.
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsSection: (({ children }: { children: ReactNode }) => children) as never,
  SettingsRow: ({ title, control, resetAction }) => (
    <div>
      <h3>{title}</h3>
      {resetAction}
      {control}
    </div>
  ),
}));

import { AgentToolListingSetting } from "./AgentToolsSettings";

const shippedDefault = DEFAULT_SERVER_SETTINGS.agentToolListing;
const otherListing: AgentToolListing = shippedDefault === "core" ? "full" : "core";
const optionName = (listing: AgentToolListing) => (listing === "core" ? /^Core/ : /^All tools/);

function setup(agentToolListing: AgentToolListing, mixed = false) {
  state.settings = { ...DEFAULT_SERVER_SETTINGS, agentToolListing };
  state.mixed = mixed;
  state.updateSettings.mockClear();
}

it("writes the chosen listing to the environment and resets to the shipped default, whichever it is", async () => {
  setup(shippedDefault);
  await using screen = await render(<AgentToolListingSetting />);
  expect(screen.container.querySelector('[aria-label^="Reset"]')).toBeNull();

  await userEvent.click(screen.getByRole("combobox", { name: "GOAT tools agents see" }));
  await userEvent.click(screen.getByRole("option", { name: optionName(otherListing) }));
  expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith({
    environmentId: "env",
    input: { patch: { agentToolListing: otherListing } },
  });

  setup(otherListing);
  await screen.rerender(<AgentToolListingSetting />);
  await userEvent.click(screen.getByRole("button", { name: /^Reset/ }));
  expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith({
    environmentId: "env",
    input: { patch: { agentToolListing: shippedDefault } },
  });
});

it("offers reset when selected environments disagree even if the shown one uses the default", async () => {
  setup(shippedDefault, true);
  await using screen = await render(<AgentToolListingSetting />);
  await expect
    .element(screen.getByRole("combobox", { name: "GOAT tools agents see" }))
    .toHaveTextContent("Mixed");
  await userEvent.click(screen.getByRole("button", { name: /^Reset/ }));
  expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith({
    environmentId: "env",
    input: { patch: { agentToolListing: shippedDefault } },
  });
});
