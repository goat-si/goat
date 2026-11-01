import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@goat/contracts";
import { createModelSelection } from "@goat/shared/model";
import { resolveMemoryModelSelection } from "@goat/shared/serverSettings";
import { useContext, useState } from "react";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance, selectsPlanAgent } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Switch } from "../ui/switch";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow, SettingsSection } from "./settingsLayout";

export function MemoryGenerationSettings({
  environmentId,
  hideModelWhenDisabled = false,
}: {
  environmentId: EnvironmentId;
  hideModelWhenDisabled?: boolean;
}) {
  const registry = useContext(RegistryContext);
  const settings = useEnvironmentSettings(environmentId);
  const providers = useEnvironmentProviders().get(environmentId) ?? [];
  const canUpdate = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(
        providers.filter((provider) => provider.supportsTextGeneration !== false),
      ),
      settings,
      null,
    ),
  );
  const selection = resolveMemoryModelSelection(settings, providers);
  const activeEntry = entries.find((entry) => entry.instanceId === selection.instanceId);
  const separate = settings.memoryModelSelection !== null;
  const options = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection.instanceId,
    selection.model,
  );
  const allowed = canUpdate && !busy;
  function save(patch: Parameters<typeof update>[0]["input"]["patch"]) {
    if (!registry.get(serverEnvironment.updateSettings.permissionAtom(environmentId)) || busy)
      return;
    setBusy(true);
    setMessage(null);
    void update({ environmentId, input: { patch } }).then((result) => {
      setMessage(result._tag === "Success" ? null : "Could not update memory settings.");
      setBusy(false);
    });
  }
  return (
    <SettingsSection title="Memory">
      <SettingsRow
        title="Remember conversations"
        description="GOAT summarizes finished conversations into memory. Turning this off stops new summaries and keeps saved memories."
        control={
          <Switch
            aria-label="Remember conversations"
            checked={settings.memoryEnabled}
            disabled={!allowed}
            onCheckedChange={(checked) => save({ memoryEnabled: checked })}
          />
        }
      />
      {(!hideModelWhenDisabled || settings.memoryEnabled) && (
        <SettingsRow
          title="Memory model"
          description="Automatic follows the text generation model. Choose a separate model for memory summaries."
          control={
            <div className="flex flex-wrap items-center justify-end gap-2">
              {!separate ? (
                <span className="text-sm text-muted-foreground">Automatic · {selection.model}</span>
              ) : null}
              {activeEntry && separate ? (
                <>
                  <ProviderModelPicker
                    environmentId={environmentId}
                    activeInstanceId={selection.instanceId}
                    model={selection.model}
                    lockedProvider={null}
                    instanceEntries={entries}
                    modelOptionsByInstance={options}
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    triggerAriaLabel="Memory model"
                    disabled={!allowed}
                    onInstanceModelChange={(instanceId, model) =>
                      save({ memoryModelSelection: createModelSelection(instanceId, model) })
                    }
                  />
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
                        memoryModelSelection: createModelSelection(
                          selection.instanceId,
                          selection.model,
                          modelOptions,
                        ),
                      })
                    }
                  />
                </>
              ) : null}
              <Switch
                aria-label="Use a separate memory model"
                checked={separate}
                disabled={!allowed || (!separate && !activeEntry)}
                onCheckedChange={(checked) =>
                  save({
                    memoryModelSelection: checked
                      ? createModelSelection(
                          selection.instanceId,
                          selection.model,
                          selection.options,
                        )
                      : null,
                  })
                }
              />
            </div>
          }
          status={message ? <span role="alert">{message}</span> : undefined}
        />
      )}
    </SettingsSection>
  );
}
