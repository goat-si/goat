import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@goat/contracts";

import { type RemoteOpenState, useRemoteOpenState } from "../../remoteOpen";
import { primaryServerAvailableEditorsAtom, serverEnvironment } from "../../state/server";

function hasOpenInTarget(isPrimary: boolean, remote: RemoteOpenState): boolean {
  return isPrimary || remote.mode !== "local-exec" || remote.desktopService === true;
}

export function useFileOpenInTarget(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
): boolean {
  return hasOpenInTarget(environmentId === primaryEnvironmentId, useRemoteOpenState(environmentId));
}

export function useThreadOpenInPicker(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  projectName: string | undefined,
) {
  const remote = useRemoteOpenState(environmentId);
  const primaryEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return {
    showOpenInPicker:
      Boolean(projectName) && hasOpenInTarget(environmentId === primaryEnvironmentId, remote),
    availableEditors:
      remote.mode === "local-exec" && remote.desktopService
        ? (config?.availableEditors ?? primaryEditors)
        : primaryEditors,
  };
}
