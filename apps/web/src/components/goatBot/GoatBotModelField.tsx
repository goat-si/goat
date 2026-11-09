import type { EnvironmentId, ModelSelection } from "@goat/contracts";
import { createModelSelection } from "@goat/shared/model";

import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { useGoatBotModel } from "./useGoatBotModel";

/** A member bot's model in its dialog; null follows the main bot's model. */
export function GoatBotModelField({
  environmentId,
  model,
  onChange,
  mainName,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly model: ModelSelection | null;
  readonly onChange: (model: ModelSelection | null) => void;
  readonly mainName: string;
  /** Names the picker for assistive technology, such as "New bot model". */
  readonly label: string;
}) {
  const { selection, entries, options } = useGoatBotModel(environmentId);
  const shown = model ?? selection;
  const name =
    entries
      .find((entry) => entry.instanceId === shown.instanceId)
      ?.models.find((entry) => entry.slug === shown.model)?.name ?? shown.model;
  return (
    <div className="grid gap-1.5 text-sm">
      Model
      <div className="flex flex-wrap items-center gap-2">
        <ProviderModelPicker
          environmentId={environmentId}
          activeInstanceId={shown.instanceId}
          model={shown.model}
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={options}
          triggerAriaLabel={`${label}: ${name}`}
          onInstanceModelChange={(instanceId, slug) =>
            onChange(createModelSelection(instanceId, slug))
          }
        />
        {model === null ? (
          <span className="text-xs text-muted-foreground">Same as {mainName}</span>
        ) : (
          <Button type="button" size="xs" variant="ghost" onClick={() => onChange(null)}>
            Use {mainName}'s model
          </Button>
        )}
      </div>
    </div>
  );
}
