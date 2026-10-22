import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ModelSelection, ProviderInstanceId } from "@goat/contracts";
import { createModelSelection } from "@goat/shared/model";
import { ProviderModelPicker } from "../components/chat/ProviderModelPicker";
import { Button } from "../components/ui/button";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { getAppModelOptionsForInstance } from "../modelSelection";
import { deriveProviderInstanceEntries, isProviderInstancePickerReady } from "../providerInstances";
import { providersIgnoringCheckedAtAtom } from "../state/server";

export function NoteModelPicker(props: {
  environmentId: EnvironmentId;
  value: ModelSelection | undefined;
  disabled: boolean;
  onChange: (value: ModelSelection | undefined) => void;
}) {
  const settings = useEnvironmentSettings(props.environmentId);
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(props.environmentId));
  const entries = deriveProviderInstanceEntries(providers).filter(isProviderInstancePickerReady);
  const selected = props.value ?? settings.defaultModelSelection;
  const entry = entries.find((item) => item.instanceId === selected?.instanceId) ?? entries[0];
  const options = new Map(
    entries.map((item) => [item.instanceId, getAppModelOptionsForInstance(settings, item)]),
  );
  function select(instanceId: ProviderInstanceId, model: string) {
    props.onChange(createModelSelection(instanceId, model));
  }
  return (
    <div className="space-y-1.5 text-sm">
      <p>Model</p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">
          {props.value ? "Selected model" : "Hub default model"}
        </span>
        {entry && (
          <ProviderModelPicker
            environmentId={props.environmentId}
            activeInstanceId={entry.instanceId}
            model={
              selected?.instanceId === entry.instanceId
                ? selected.model
                : (entry.models[0]?.slug ?? "")
            }
            lockedProvider={null}
            instanceEntries={entries}
            modelOptionsByInstance={options}
            onInstanceModelChange={select}
            disabled={props.disabled}
            triggerAriaLabel="Model for note work"
            {...(props.value ? {} : { triggerLabel: "Choose another model" })}
            isComposerOwned={false}
          />
        )}
        {props.value && (
          <Button
            size="xs"
            variant="outline"
            disabled={props.disabled}
            onClick={() => props.onChange(undefined)}
          >
            Use default
          </Button>
        )}
      </div>
    </div>
  );
}
