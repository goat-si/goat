import { render } from "../../../test/render";
import { EnvironmentId, ProviderInstanceId, type ServerProvider } from "@goat/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@goat/contracts/settings";
import { createModelSelection } from "@goat/shared/model";
import { StrictMode, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import { provider } from "../../modelSelection.testkit";
import type { ScopedSettingsPatch } from "./scopedSettings";

type WritingStyle = typeof DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle;
const state = vi.hoisted(() => ({
  styles: [] as WritingStyle[],
  reviewGuideSettings: null as UnifiedSettings | null,
  providers: [] as ServerProvider[],
  updateSettings: vi.fn<(patch: ScopedSettingsPatch) => void>(),
}));
const environmentId = EnvironmentId.make("source-control-settings");

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => vi.fn()) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() =>
    state.reviewGuideSettings ?? {
      ...DEFAULT_UNIFIED_SETTINGS,
      sourceControlWritingStyle: state.styles[0],
    }) as never,
  useScopedSettingsMixed: (keys) =>
    !keys.includes("reviewGuidesEnabled") &&
    JSON.stringify(state.styles[0]) !== JSON.stringify(state.styles[1]),
  useUpdateScopedSettings: () => state.updateSettings,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "all", environmentIds: [] },
    environment: state.reviewGuideSettings ? { environmentId, serverConfig: {} } : null,
    connectedEnvironments: state.reviewGuideSettings ? [{ environmentId }] : [],
    targets: state.styles.map((style) => ({
      settings: { ...DEFAULT_UNIFIED_SETTINGS, sourceControlWritingStyle: style },
    })),
    target: null,
  })) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentProviders: () => new Map([[environmentId, state.providers]]),
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ title, control, resetAction, children }) => (
    <div>
      <h3>{title}</h3>
      {control}
      {resetAction}
      {children}
    </div>
  ),
  SettingsSection: (({ children }: { children: ReactNode }) => children) as never,
}));

import { SourceControlWritingSettingsSection } from "./SourceControlWritingSettings";

const resetButton = (label: string) =>
  page.getByRole("button", { name: `Reset ${label} to default` });

const content = () => (
  <StrictMode>
    <SourceControlWritingSettingsSection />
  </StrictMode>
);

async function setup() {
  state.reviewGuideSettings = null;
  state.providers = [];
  state.styles = [
    {
      ...DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle,
      mode: "custom",
      customInstructions: "First environment instructions",
      followChangeRequestTemplates: true,
    },
    {
      ...DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle,
      mode: "custom",
      customInstructions: "Second environment instructions",
      followChangeRequestTemplates: false,
    },
  ];
  const screen = await render(content());
  state.updateSettings.mockReset().mockImplementation((patch) => {
    state.styles = state.styles.map((style) => ({ ...style, ...patch.sourceControlWritingStyle }));
    void screen.rerender(content());
  });
  return screen;
}

describe("mixed source control instructions", () => {
  it("resets mixed template preferences without replacing each environment's instructions", async () => {
    await using _screen = await setup();
    const initialInstructions = state.styles.map(({ mode, customInstructions }) => ({
      mode,
      customInstructions,
    }));

    await expect.element(resetButton("pull request templates")).toBeInViewport({ ratio: 1 });
    await userEvent.click(resetButton("pull request templates"));

    expect(state.updateSettings).toHaveBeenCalledTimes(1);
    expect(state.styles.map((style) => style.followChangeRequestTemplates)).toEqual([
      DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle.followChangeRequestTemplates,
      DEFAULT_UNIFIED_SETTINGS.sourceControlWritingStyle.followChangeRequestTemplates,
    ]);
    expect(
      state.styles.map(({ mode, customInstructions }) => ({ mode, customInstructions })),
    ).toEqual(initialInstructions);
  });
});

it.each(["API writer fallback", "saved text generation model"])(
  "shows the review guide model from the %s even when it is hidden from the menu",
  async (source) => {
    const codex = provider({ instanceId: "codex", models: ["gpt-6-astra", "gpt-6-luna"] });
    const api = createModelSelection(ProviderInstanceId.make("text-api"), "api-model");
    state.styles = [];
    state.providers = [codex];
    state.reviewGuideSettings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      reviewGuidesEnabled: true,
      reviewGuideModelSelection: createModelSelection(
        ProviderInstanceId.make("missing-instance"),
        "removed-model",
      ),
      sourceControlWriterModelSelection: source === "API writer fallback" ? api : null,
      textGenerationModelSelection: createModelSelection(
        codex.instanceId,
        source === "API writer fallback" ? "gpt-6-astra" : "gpt-6-luna",
      ),
      textGenerators: {
        [api.instanceId]: {
          kind: "openaiCompatible",
          baseUrl: "https://model.example/v1",
          apiKey: "",
          enabled: true,
        },
      },
      providerModelPreferences: {
        [codex.instanceId]: { hiddenModels: ["gpt-6-luna"], modelOrder: [] },
      },
    };

    await using _screen = await render(content());
    const trigger = page.getByRole("button", { name: "Review guide model", exact: true });
    await expect.element(trigger).toHaveTextContent("gpt-6-luna");
    await trigger.click();
    await expect.element(page.getByRole("option", { name: /astra/i })).toBeVisible();
    await expect.element(page.getByRole("option", { name: /luna/i })).not.toBeInTheDocument();
  },
);
