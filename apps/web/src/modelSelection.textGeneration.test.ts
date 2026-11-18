import { ProviderDriverKind } from "@goat/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@goat/contracts/settings";
import { createModelSelection } from "@goat/shared/model";
import {
  resolveTextGenerationRoute,
  textGenerationDefaultModel,
} from "@goat/shared/serverSettings";
import { describe, expect, it } from "vite-plus/test";
import {
  getCustomModelOptionsByInstance,
  getTextGenerationModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "./modelSelection";
import { provider } from "./modelSelection.testkit";

const astra = "gpt-6-astra";
const luna = "gpt-6-luna";
const oldLuna = "gpt-5.6-luna";
const qualifiedLuna = "openai.gpt-6-luna";
const custom = "my-custom-model";

it.each(
  (
    [
      ["saved, listed", astra, [astra, luna], [], astra],
      ["saved, qualified alias", luna, [astra, qualifiedLuna], [], qualifiedLuna],
      [
        "saved, legacy alias for qualified model",
        "5.4",
        [astra, "openai.gpt-5.4"],
        [],
        "openai.gpt-5.4",
      ],
      ["saved, qualified slug", qualifiedLuna, [astra, qualifiedLuna], [], qualifiedLuna],
      ["saved, qualified slug with bare catalog", qualifiedLuna, [astra, luna], [], luna],
      ["saved, configured custom outside catalog", custom, [astra, luna], [custom], custom],
      ["saved, configured custom inside catalog", custom, [astra, luna, custom], [custom], custom],
      ["removed, stale custom snapshot", custom, [astra, luna, custom], [], luna],
      ["removed, preferred model listed", oldLuna, [astra, luna], [], luna],
      ["removed, preferred model qualified", oldLuna, [astra, qualifiedLuna], [], qualifiedLuna],
      ["removed, only advertised default", oldLuna, [astra], [], astra],
      ["removed, no advertised default", oldLuna, ["gpt-6-sol"], [], "gpt-6-sol"],
      ["saved, empty catalog", oldLuna, [], [], oldLuna],
      ["saved custom, empty catalog", custom, [], [custom], custom],
    ] as const
  ).flatMap(([state, saved, catalog, customModels, expected]) =>
    [false, true].map((hidden) => ({
      state,
      saved,
      catalog,
      customModels,
      expected,
      visibility: hidden ? "hidden" : "visible",
      hiddenModels: hidden ? [...new Set([saved, expected])] : [],
    })),
  ),
)(
  "shows and dispatches the same Codex model ($state, $visibility)",
  ({ saved, catalog, customModels, expected, hiddenModels }) => {
    const codex = provider({ instanceId: "codex", models: catalog });
    const providers = [
      {
        ...codex,
        models: codex.models.map((model) => ({
          ...model,
          isDefault: model.slug === astra,
          isCustom: model.slug === custom,
        })),
      },
    ];
    const selection = createModelSelection(codex.instanceId, saved);
    const settings: UnifiedSettings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [codex.instanceId]: { driver: codex.driver, config: { customModels } },
      },
      textGenerationModelSelection: selection,
      providerModelPreferences: { [codex.instanceId]: { hiddenModels, modelOrder: [] } },
    };

    expect({
      settings: resolveAppModelSelectionState(settings, providers).model,
      dispatch: resolveTextGenerationRoute(settings, selection, providers, null, 0).selection
        ?.model,
    }).toEqual({ settings: expected, dispatch: expected });
  },
);

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
          enabled: true,
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

  // The server moves off a flagged model with the same rule, so Settings shows what runs.
  it("resolves a flagged OmO model to the model the server runs", () => {
    const listed = provider({
      provider: ProviderDriverKind.make("omo"),
      instanceId: "omo",
      models: ["default", "demo/demo-model"],
    });
    const omo = {
      ...listed,
      models: listed.models.map((model) =>
        model.slug === "demo/demo-model" ? { ...model, supportsTextGeneration: false } : model,
      ),
    };
    const settings: UnifiedSettings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [omo.instanceId]: { driver: ProviderDriverKind.make("omo"), enabled: true, config: {} },
      },
      textGenerationModelSelection: createModelSelection(omo.instanceId, "demo/demo-model"),
    };
    const shown = resolveAppModelSelectionState(settings, [omo]);
    expect(shown.model).toBe(textGenerationDefaultModel(omo));
    expect(shown.model).toBe("default");
  });
});
