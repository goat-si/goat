import { useEffect, useRef } from "react";
import type { EnvironmentId, ProviderInstanceId } from "@goat/contracts";
import { isLoopbackHost } from "@goat/shared/preview";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentPresentations } from "../../state/presentation";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { readPreparedConnection } from "../../state/session";

export const isLoopbackUrl = (url: string | null) =>
  url !== null && isLoopbackHost(new URL(url).hostname);

// A loopback server can receive the provider's callback itself, unless the
// desktop shell offers to catch it on the client.
export const prefersClientCallback = (local: boolean) =>
  !local || window.desktopBridge?.receiveProviderAuthCallback !== undefined;

// The primary connection may change while an install is running.
export function readSignInRouting(environmentId: EnvironmentId) {
  const local = isLoopbackUrl(readPreparedConnection(environmentId)?.httpBaseUrl ?? null);
  const clientCallback = prefersClientCallback(local);
  const primaryEnvironmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
  const primaryAuthEnvironmentId =
    !local &&
    primaryEnvironmentId !== null &&
    appAtomRegistry.get(environmentPresentations.presentationAtom(primaryEnvironmentId))?.connection
      .phase === "connected" &&
    isLoopbackUrl(readPreparedConnection(primaryEnvironmentId)?.httpBaseUrl ?? null) &&
    (window.desktopBridge !== undefined || isLoopbackHost(window.location.hostname))
      ? primaryEnvironmentId
      : null;
  return {
    clientCallback,
    remoteWeb: clientCallback && !window.desktopBridge?.receiveProviderAuthCallback,
    primaryAuthEnvironmentId,
  };
}

export function useCodexSetupOperation() {
  const operation = useRef<AbortController | null>(null);
  const beginOperation = () => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    return controller.signal;
  };
  const abortOperation = () => operation.current?.abort();
  // oxlint-disable-next-line goat/react-effect-budget -- Unmount must abort pending install and authorization continuations.
  useEffect(() => () => operation.current?.abort(), []);
  const getOrBeginOperation = () =>
    operation.current && !operation.current.signal.aborted
      ? operation.current.signal
      : beginOperation();
  return { beginOperation, abortOperation, getOrBeginOperation };
}

export function readCodexReturnUrl(environmentId: EnvironmentId, instanceId: ProviderInstanceId) {
  const returnUrl = new URL(window.location.href);
  if (returnUrl.pathname === "/welcome") returnUrl.hash = `agents:${environmentId}`;
  if (returnUrl.pathname === "/settings/providers")
    returnUrl.searchParams.set("instanceId", instanceId);
  return returnUrl;
}
