import { ProviderDriverKind } from "@goat/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@goat/contracts/settings";
import { createModelSelection } from "@goat/shared/model";
import { describe, expect, it } from "vite-plus/test";
import {
  getCustomModelOptionsByInstance,
  getTextGenerationModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "./modelSelection";
import { provider } from "./modelSelection.testkit";

describe("instance-scoped model selection", () => {
  it("excludes customized extension models while preserving unknown custom and thread models", () => {
    const pi = provider({
      provider: ProviderDriverKind.make("pi"),
      instanceId: "pi",
      models: ["default", "demo/demo-model"],
    });
    const providers = [
      {
        ...pi,
        models: pi.models.map((model) =>
          model.slug === "demo/demo-model" ? { ...model, supportsTextGeneration: false } : model,
        ),
      },
    ];
    const settings: UnifiedSettings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [pi.instanceId]: {
          driver: ProviderDriverKind.make("pi"),
          config: {
            customModels: [
              { slug: "demo/demo-model", name: "My extension model" },
              { slug: "unknown/model", name: "My custom model" },
            ],
          },
        },
      },
      textGenerationModelSelection: createModelSelection(pi.instanceId, "demo/demo-model"),
    };
    const supported = providers.filter((provider) => provider.supportsTextGeneration !== false);
    expect(
      getTextGenerationModelOptionsByInstance(settings, supported, pi.instanceId, "demo/demo-model")
        .get(pi.instanceId)
        ?.map((option) => option.slug),
    ).toEqual(["default", "unknown/model"]);
    expect(resolveAppModelSelectionState(settings, supported)).toEqual(
      createModelSelection(pi.instanceId, "default"),
    );
    expect(
      resolveAppModelSelectionState(
        {
          ...settings,
          textGenerationModelSelection: createModelSelection(pi.instanceId, "unknown/model"),
        },
        supported,
      ).model,
    ).toBe("unknown/model");
    expect(
      getCustomModelOptionsByInstance(settings, providers)
        .get(pi.instanceId)
        ?.map((option) => option.slug),
    ).toEqual(["default", "demo/demo-model", "unknown/model"]);
  });
});
