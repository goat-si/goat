import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import {
  persistClientSettingsPatch,
  useClientSettings,
  useClientSettingsHydrated,
} from "../../hooks/useSettings";
import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import { primaryServerConfigAtom } from "../../state/server";
import { ComputerUseSetup, useComputerUseHost } from "../settings/ComputerUseSettings";

/**
 * Asks once per desktop profile whether agents may use this computer. Later leaves computer
 * use off; Settings → Integrations → Computer use turns it on at any time.
 */
export function ComputerUseFirstRunPrompt() {
  const hydrated = useClientSettingsHydrated();
  const prompt = useClientSettings((settings) => settings.computerUsePrompt);
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  if (!hydrated || prompt !== "pending" || serverConfig === null || isLocalEnvironmentDisabled())
    return null;
  return <LocalComputerUsePrompt environmentId={serverConfig.environment.environmentId} />;
}

function LocalComputerUsePrompt({
  environmentId,
}: {
  environmentId: Parameters<typeof useComputerUseHost>[0];
}) {
  const host = useComputerUseHost(environmentId, true);
  const alreadyOn = host.enabled;
  // Someone turned it on elsewhere first; that answers the question.
  useEffect(() => {
    if (alreadyOn) void persistClientSettingsPatch({ computerUsePrompt: "enabled" });
  }, [alreadyOn]);
  if (alreadyOn || !host.canConfigure || host.status === null || host.status.platform === "other")
    return null;
  return (
    <ComputerUseSetup
      host={host}
      hostLabel={host.status.platform === "darwin" ? "this Mac" : "this computer"}
      onClose={(outcome) =>
        void persistClientSettingsPatch({
          computerUsePrompt: outcome === "enabled" ? "enabled" : "later",
        })
      }
    />
  );
}
