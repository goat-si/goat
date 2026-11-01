import type { EnvironmentId } from "@goat/contracts";
import { createModelSelection } from "@goat/shared/model";

import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { toastManager } from "../ui/toast";
import { useGoatBotHomeSettings } from "./useGoatBotHome";
import { useGoatBotModel } from "./useGoatBotModel";

/** GOAT Bot's model, switchable from its header. Hidden until the bot's home computer is connected. */
export function GoatBotModelPicker() {
  const { resolution } = useGoatBotHomeSettings();
  if (resolution.state !== "claimed" || !resolution.homeConnected) return null;
  return (
    <GoatBotHomeModelPicker
      key={resolution.claim.environmentId}
      environmentId={resolution.claim.environmentId}
    />
  );
}

function GoatBotHomeModelPicker({ environmentId }: { environmentId: EnvironmentId }) {
  const { activeEntry, selection, separate, entries, options, allowed, save } =
    useGoatBotModel(environmentId);
  const modelName =
    activeEntry?.models.find((model) => model.slug === selection.model)?.name ?? selection.model;
  return (
    <ProviderModelPicker
      environmentId={environmentId}
      activeInstanceId={selection.instanceId}
      model={selection.model}
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={options}
      popupAlign="end"
      triggerAriaLabel={`GOAT Bot model: ${modelName}${separate ? "" : " (automatic)"}`}
      disabled={!allowed}
      onInstanceModelChange={(instanceId, model) => {
        void save({ goatBotModelSelection: createModelSelection(instanceId, model) }).then(
          (saved) => {
            if (!saved)
              toastManager.add({ type: "error", title: "Couldn't change GOAT Bot's model" });
          },
        );
      }}
    />
  );
}
