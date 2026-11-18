import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@goat/contracts";
import { createModelSelection } from "@goat/shared/model";
import { resolveTextGenerationFallback } from "@goat/shared/serverSettings";
import { describe, expect, it } from "vite-plus/test";

import { resolveAppModelSelectionState } from "./modelSelection";
import { provider, settingsWithProviderInstances } from "./modelSelection.testkit";

const unsupported = provider({
  provider: ProviderDriverKind.make("antigravity"),
  instanceId: "antigravity",
  models: ["gemini-3.1-pro"],
  supportsTextGeneration: false,
});
const codex = provider({ instanceId: "codex", models: ["gpt-6-luna"] });
const claude = provider({
  provider: ProviderDriverKind.make("claudeAgent"),
  instanceId: "claudeAgent",
  models: ["claude-haiku-5-5"],
});
const settings = {
  ...settingsWithProviderInstances(),
  textGenerationModelSelection: createModelSelection(unsupported.instanceId, "gemini-3.1-pro"),
};
const serverFallback = (providers: ReadonlyArray<ServerProvider>) =>
  resolveTextGenerationFallback(settings, providers, {
    projectId: null,
    excludeInstanceId: unsupported.instanceId,
    now: Date.parse("2026-01-01T00:00:00.000Z"),
  })?.instanceId;

describe("Settings names the text generation fallback the server runs", () => {
  it("skips a signed-out provider the way the server does", () => {
    const providers = [
      unsupported,
      { ...codex, auth: { status: "unauthenticated" as const } },
      claude,
    ];

    expect(resolveAppModelSelectionState(settings, providers).instanceId).toBe(
      ProviderInstanceId.make("claudeAgent"),
    );
    expect(serverFallback(providers)).toBe(ProviderInstanceId.make("claudeAgent"));
  });

  it("takes the server's driver order, not the provider list order", () => {
    const providers = [unsupported, claude, codex];

    expect(resolveAppModelSelectionState(settings, providers).instanceId).toBe(
      ProviderInstanceId.make("codex"),
    );
    expect(serverFallback(providers)).toBe(ProviderInstanceId.make("codex"));
  });
  it("shows the resolved fallback model even when it is hidden from the picker", () => {
    const missing = ProviderInstanceId.make("missing-instance");
    const selected = {
      ...settings,
      textGenerationModelSelection: createModelSelection(missing, "missing-model"),
      providerModelPreferences: {
        [codex.instanceId]: { hiddenModels: ["gpt-6-luna"], modelOrder: [] },
      },
    };
    const providers = [
      {
        ...codex,
        models: [
          ...codex.models,
          ...provider({ instanceId: "codex", models: ["gpt-6-astra"] }).models,
        ],
      },
    ];
    expect(resolveAppModelSelectionState(selected, providers)).toEqual(
      createModelSelection(codex.instanceId, "gpt-6-luna"),
    );
  });
});
