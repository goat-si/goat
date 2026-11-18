import { ProviderInstanceId } from "@goat/contracts";
import { createModelSelection } from "@goat/shared/model";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import {
  getTextGenerationModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { provider, settingsWithProviderInstances } from "../../modelSelection.testkit";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import "../../index.css";

it("displays the resolved text generation fallback even when it is hidden from the menu", async () => {
  const codex = provider({ instanceId: "codex", models: ["gpt-6-astra", "gpt-6-luna"] });
  const providers = [
    {
      ...codex,
      models: codex.models.map((model) => ({
        ...model,
        name: model.slug === "gpt-6-luna" ? "Resolved fallback model" : "Other model",
      })),
    },
  ];
  const settings = {
    ...settingsWithProviderInstances(),
    textGenerationModelSelection: createModelSelection(
      ProviderInstanceId.make("missing-instance"),
      "missing-model",
    ),
    providerModelPreferences: {
      [codex.instanceId]: { hiddenModels: ["gpt-6-luna"], modelOrder: [] },
    },
  };
  const selection = resolveAppModelSelectionState(settings, providers);
  await using _screen = await render(
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={selection.instanceId}
      model={selection.model}
      lockedProvider={null}
      instanceEntries={deriveProviderInstanceEntries(providers)}
      modelOptionsByInstance={getTextGenerationModelOptionsByInstance(
        settings,
        providers,
        selection.instanceId,
        selection.model,
      )}
      preserveSelectedModel
      onInstanceModelChange={() => {}}
    />,
  );
  const trigger = page.getByRole("button", { name: "Resolved fallback model" });
  await expect.element(trigger).toBeVisible();
  await trigger.click();
  await expect.element(page.getByRole("option", { name: /Other model/ })).toBeVisible();
  await expect
    .element(page.getByRole("option", { name: /Resolved fallback model/ }))
    .not.toBeInTheDocument();
});
