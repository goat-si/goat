import { DEFAULT_UNIFIED_SETTINGS, ProviderInstanceId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { resolveAppModelSelectionState } from "./modelSelection";

it("preserves the configured model API instead of replacing it with a CLI provider", () => {
  const instanceId = ProviderInstanceId.make("text-api");
  const selection = { instanceId, model: "small-model" };
  const settings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    textGenerationModelSelection: selection,
    textGenerators: {
      [instanceId]: {
        kind: "openaiCompatible" as const,
        baseUrl: "https://api.example/v1",
        apiKey: "••••••",
        enabled: true,
      },
    },
  };
  expect(resolveAppModelSelectionState(settings, [])).toEqual(selection);
  expect(
    resolveAppModelSelectionState(
      {
        ...settings,
        textGenerators: {
          [instanceId]: { ...settings.textGenerators[instanceId]!, enabled: false },
        },
      },
      [],
    ).instanceId,
  ).not.toBe(instanceId);
});
