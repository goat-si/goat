import { deriveGoatBotModelSettings } from "@goat/client-runtime/goatBot";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ServerSettingsPatch,
} from "@goat/contracts";
import { useState } from "react";
import { Alert } from "react-native";

import { useEnvironmentServerConfig } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { goatBotModelMenu, goatBotModelMenuPatch } from "./goatBotModelMenu";
import { useMobileGoatBotHomeSettings } from "./useMobileGoatBotHomeSettings";

/** GOAT Bot's model on its home computer. Settings and the GOAT Bot header save it the same way. */
export function useMobileGoatBotModel(environmentId: EnvironmentId | null, canWrite: boolean) {
  const config = useEnvironmentServerConfig(environmentId);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "environment settings update",
    reportFailure: false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (environmentId === null || !config) return null;
  const state = deriveGoatBotModelSettings({
    settings: config.settings,
    providers: config.providers,
  });
  function save(patch: ServerSettingsPatch): Promise<boolean> {
    if (
      environmentId === null ||
      saving ||
      !readEnvironmentScope(environmentId, AuthSettingsWriteScope)
    )
      return Promise.resolve(false);
    setSaving(true);
    setError(null);
    return updateSettings({ environmentId, input: { patch } })
      .then((result) => result._tag === "Success")
      .catch(() => false)
      .then((saved) => {
        setError(saved ? null : "Could not update GOAT Bot settings.");
        return saved;
      })
      .finally(() => setSaving(false));
  }
  return { state, settings: config.settings, saving, error, allowed: canWrite && !saving, save };
}

/** The GOAT Bot header's model menu, or null until GOAT Bot's home computer is connected. */
export function useMobileGoatBotModelMenu() {
  const { resolution, writableIds } = useMobileGoatBotHomeSettings();
  const environmentId =
    resolution.state === "claimed" && resolution.homeConnected
      ? resolution.claim.environmentId
      : null;
  const model = useMobileGoatBotModel(
    environmentId,
    environmentId !== null && writableIds.has(environmentId),
  );
  if (model === null) return null;
  return {
    ...goatBotModelMenu(model.state),
    disabled: !model.allowed,
    select: (id: string) => {
      const patch = goatBotModelMenuPatch(model.state, id);
      if (patch === null || !model.allowed) return;
      void model.save(patch).then((saved) => {
        if (!saved) Alert.alert("Couldn't change GOAT Bot's model", "Try again in a moment.");
      });
    },
  };
}
