import { useMemo } from "react";
import { useEnvironments } from "../../state/environments";
import { useStoredHubEnvironment } from "../connection/useStoredHubEnvironment";
import { mobileEnvironmentHueKey, mobileEnvironmentHuesFromKey } from "./environmentHues";

export function useEnvironmentHues() {
  const { environments } = useEnvironments();
  const { storedHubId, loaded } = useStoredHubEnvironment();
  const key = loaded
    ? mobileEnvironmentHueKey(
        environments.map(({ environmentId, relayManaged }) => ({
          environmentId,
          isRelayManaged: relayManaged,
        })),
        storedHubId,
      )
    : null;
  return useMemo(
    () => (key === null ? new Map<string, string>() : mobileEnvironmentHuesFromKey(key)),
    [key],
  );
}
