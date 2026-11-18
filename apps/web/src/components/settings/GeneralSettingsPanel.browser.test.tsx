import { EnvironmentId } from "@goat/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@goat/contracts/settings";
import { createModelSelection } from "@goat/shared/model";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";
import { provider } from "../../modelSelection.testkit";
import type { ScopedSettingsPatch } from "./scopedSettings";
import { GeneralSettingsPanel } from "./SettingsPanels";

const environmentId = EnvironmentId.make("text-generation-settings");
const codex = provider({ instanceId: "codex", models: ["gpt-6-astra", "gpt-6-luna"] });
const providers = [
  {
    ...codex,
    models: codex.models.map((model) => ({
      ...model,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select" as const,
            options: [
              { id: "medium", label: "Medium", isDefault: true },
              { id: "high", label: "High" },
            ],
          },
        ],
      },
    })),
  },
];
const settings = {
  ...DEFAULT_UNIFIED_SETTINGS,
  textGenerationModelSelection: createModelSelection(codex.instanceId, "gpt-6-luna"),
  providerModelPreferences: {
    [codex.instanceId]: { hiddenModels: ["gpt-6-luna"], modelOrder: [] },
  },
};
const { updateSettings } = vi.hoisted(() => ({
  updateSettings: vi.fn<(patch: ScopedSettingsPatch) => void>(),
}));

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useUpdateScopedSettings: () => updateSettings,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "environment", environmentIds: [environmentId] },
    environment: { environmentId, serverConfig: {} },
    connectedEnvironments: [{ environmentId }],
    targets: [],
    target: { environmentId, projectId: null, settings },
  })) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentProviders: () => new Map([[environmentId, providers]]),
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ title, control, children }) => (
    <div>
      {title}
      {control}
      {children}
    </div>
  ),
}));

it("shows the saved text generation model while hiding it from the menu", async () => {
  updateSettings.mockReset();
  await using screen = await render(<GeneralSettingsPanel />);
  const trigger = screen.getByRole("button", { name: /^gpt-6-(astra|luna)$/ });
  await expect.element(trigger).toHaveTextContent("gpt-6-luna");
  await trigger.click();
  await expect.element(page.getByRole("option", { name: /astra/i })).toBeVisible();
  await expect.element(page.getByRole("option", { name: /luna/i })).not.toBeInTheDocument();
});

it("saves an effort change on the hidden text generation model", async () => {
  updateSettings.mockReset();
  await using screen = await render(<GeneralSettingsPanel />);
  await screen.getByRole("button", { name: "Medium", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "High", exact: true }).click();
  expect(updateSettings).toHaveBeenCalledWith({
    textGenerationModelSelection: createModelSelection(codex.instanceId, "gpt-6-luna", [
      { id: "effort", value: "high" },
    ]),
  });
});
