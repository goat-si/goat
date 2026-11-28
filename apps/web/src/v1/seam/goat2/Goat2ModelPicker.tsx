// GOAT 2's model picker: v1's ProviderModelPicker with the entries and model options derived exactly as v1's GOAT Bot
// picker derives them (components/goatBot/useGoatBotModel.ts:28-38 at goat 916b5ccc1b2) for GOAT 2's one environment.
// The GOAT 2 frame owns where the choice goes (change_thread on the thread, docs/part2/provider-wire.md).
import type { ProviderInstanceId } from "@goat/contracts";
import { ProviderModelPicker } from "../../components/chat/ProviderModelPicker";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { applyProviderInstanceSettings, deriveProviderInstanceEntries, sortProviderInstanceEntries } from "../../providerInstances";
import { useEnvironmentProviders } from "../state/environments";
import { GOAT2_ENVIRONMENT_ID } from "./environment";

export interface Goat2ModelPickerProps {
  instanceId: string;
  model: string;
  onChange: (selection: { instanceId: string; model: string }) => void;
  /** The composer's picker also offers "Add provider" (v1 isComposerOwned). */
  composer?: boolean;
  popupAlign?: "start" | "end";
  ariaLabel?: string;
  disabled?: boolean;
  /** The host's refusal of the last choice, shown next to the trigger. */
  error?: string | null;
}

export function Goat2ModelPicker(props: Goat2ModelPickerProps) {
  const settings = useEnvironmentSettings(GOAT2_ENVIRONMENT_ID);
  const providers = useEnvironmentProviders().get(GOAT2_ENVIRONMENT_ID) ?? [];
  const instanceId = props.instanceId as ProviderInstanceId;
  const entries = sortProviderInstanceEntries(applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null));
  const options = getCustomModelOptionsByInstance(settings, providers, instanceId, props.model);
  return (
    <>
    <ProviderModelPicker
      environmentId={GOAT2_ENVIRONMENT_ID}
      activeInstanceId={instanceId}
      model={props.model}
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={options}
      isComposerOwned={props.composer === true}
      {...(props.popupAlign ? { popupAlign: props.popupAlign } : {})}
      {...(props.ariaLabel ? { triggerAriaLabel: props.ariaLabel } : {})}
      {...(props.disabled ? { disabled: true } : {})}
      onInstanceModelChange={(next, model) => props.onChange({ instanceId: next, model })}
    />
    {props.error ? (
      <span role="alert" title={props.error} className="ms-1 max-w-56 truncate text-xs text-destructive-foreground">
        {props.error}
      </span>
    ) : null}
    </>
  );
}
