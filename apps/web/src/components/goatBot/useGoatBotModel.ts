import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { deriveGoatBotModelState } from "@goat/client-runtime/goatBot";
import type { EnvironmentId, ServerSettingsPatch } from "@goat/contracts";
import { useContext, useState } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "~/providerInstances";
import { useEnvironmentProviders } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

/**
 * GOAT Bot's model on its home computer, read from the same provider catalog as the composer.
 * Settings and the GOAT Bot header share it, so both show and save the same choice.
 */
export function useGoatBotModel(environmentId: EnvironmentId) {
  const registry = useContext(RegistryContext);
  const settings = useEnvironmentSettings(environmentId);
  const providers = useEnvironmentProviders().get(environmentId) ?? [];
  const canUpdate = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
  );
  const state = deriveGoatBotModelState({ settings, entries });
  const options = getCustomModelOptionsByInstance(
    settings,
    providers,
    state.selection.instanceId,
    state.selection.model,
  );
  function save(patch: ServerSettingsPatch): Promise<boolean> {
    if (!registry.get(serverEnvironment.updateSettings.permissionAtom(environmentId)) || busy)
      return Promise.resolve(false);
    setBusy(true);
    setMessage(null);
    return update({ environmentId, input: { patch } }).then((result) => {
      const saved = result._tag === "Success";
      setMessage(saved ? null : "Could not update GOAT Bot settings.");
      setBusy(false);
      return saved;
    });
  }
  return { ...state, settings, entries, options, allowed: canUpdate && !busy, message, save };
}
