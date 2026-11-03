import { useMemo } from "react";
import { useEnvironments } from "../../state/environments";
import { selectHubEnvironmentId } from "../connection/hubEnvironment";
import { assignMobileEnvironmentHues } from "./environmentHues";
import { useStoredHubEnvironment } from "../connection/useStoredHubEnvironment";

export function useEnvironmentHues() {
  const { environments } = useEnvironments();
  const { storedHubId, loaded } = useStoredHubEnvironment();
  return useMemo(() => {
    if (!loaded) return new Map<string, string>();
    const hub = selectHubEnvironmentId(
      environments.filter((environment) => !environment.relayManaged),
      storedHubId,
    );
    return assignMobileEnvironmentHues(
      environments.map((environment) => environment.environmentId),
      hub,
    );
  }, [environments, storedHubId, loaded]);
}
