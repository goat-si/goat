import type { EnvironmentId } from "@goat/contracts";
import { createModelSelection } from "@goat/shared/model";

import { selectsPlanAgent } from "../../modelSelection";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { useGoatBotHomeSettings } from "../goatBot/useGoatBotHome";
import { useGoatBotModel } from "../goatBot/useGoatBotModel";
import { Switch } from "../ui/switch";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** The model GOAT Bot's own turns run on, saved on the computer GOAT Bot runs on. */
export function GoatBotModelSettings() {
  const { resolution } = useGoatBotHomeSettings();
  if (resolution.state !== "claimed" || !resolution.homeConnected) return null;
  return <GoatBotModelRow environmentId={resolution.claim.environmentId} />;
}

function GoatBotModelRow({ environmentId }: { environmentId: EnvironmentId }) {
  const {
    activeEntry,
    automaticLabel,
    initialSelection,
    selection,
    separate,
    settings,
    entries,
    options,
    allowed,
    message,
    save,
  } = useGoatBotModel(environmentId);
  return (
    <>
      <SettingsRow
        {...searchableSetting("goat-bot-model")}
        description="The model GOAT Bot uses when it looks into something itself. Automatic follows the default model for new threads."
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {!separate ? (
              <span className="text-sm text-muted-foreground">{automaticLabel}</span>
            ) : null}
            {separate ? (
              <>
                <ProviderModelPicker
                  environmentId={environmentId}
                  activeInstanceId={selection.instanceId}
                  model={selection.model}
                  lockedProvider={null}
                  instanceEntries={entries}
                  modelOptionsByInstance={options}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  triggerAriaLabel="GOAT Bot model"
                  disabled={!allowed}
                  onInstanceModelChange={(instanceId, model) =>
                    save({ goatBotModelSelection: createModelSelection(instanceId, model) })
                  }
                />
                {activeEntry ? (
                  <TraitsPicker
                    provider={activeEntry.driverKind}
                    models={activeEntry.models}
                    model={selection.model}
                    modelOptions={selection.options ?? []}
                    allowPromptInjectedEffort={false}
                    planModeEnabled={
                      settings.planModeEnabled || selectsPlanAgent(selection.options)
                    }
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    disabled={!allowed}
                    onModelOptionsChange={(modelOptions) =>
                      save({
                        goatBotModelSelection: createModelSelection(
                          selection.instanceId,
                          selection.model,
                          modelOptions,
                        ),
                      })
                    }
                  />
                ) : null}
              </>
            ) : null}
            <Switch
              aria-label="Choose a model for GOAT Bot"
              checked={separate}
              disabled={!allowed || (!separate && initialSelection === null)}
              onCheckedChange={(checked) =>
                save({
                  goatBotModelSelection: !checked ? null : initialSelection,
                })
              }
            />
          </div>
        }
        status={message ? <span role="alert">{message}</span> : undefined}
      />
      <SettingsRow
        {...searchableSetting("channel-auto-placement")}
        description="Let channel workers use connected SSH computers with the same repository and requested model, based on quota and active work. Worker instructions, notes and named skills go to the selected computer. Off keeps unnamed work here."
        control={
          <Switch
            aria-label="Automatically choose a worker computer"
            checked={settings.channelAutoPlacement}
            disabled={!allowed}
            onCheckedChange={(checked) => save({ channelAutoPlacement: checked })}
          />
        }
      />
    </>
  );
}
