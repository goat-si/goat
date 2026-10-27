import { useCallback, useEffect, useRef } from "react";
import type { EnvironmentId, ProviderInstanceId } from "@goat/contracts";
import { isLoopbackHost } from "@goat/shared/preview";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentPresentations } from "../../state/presentation";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { readPreparedConnection } from "../../state/session";
import { ensureLocalApi } from "../../localApi";

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

export function useCodexAuthCallback() {
  const receiver = useRef<{
    url: string;
    signal: AbortSignal;
    promise: Promise<string>;
    cancelled: boolean;
  } | null>(null);
  const cancelCallback = useCallback((url?: string) => {
    const active = receiver.current;
    if (!active || active.cancelled || (url !== undefined && active.url !== url)) return;
    active.cancelled = true;
    void window.desktopBridge?.cancelProviderAuthCallback?.(active.url).catch(() => undefined);
  }, []);
  const receiveCallback = async (url: string, signal: AbortSignal): Promise<string | null> => {
    if (signal.aborted) return null;
    const previous = receiver.current;
    if (previous) {
      if (previous.url === url && !previous.cancelled && !previous.signal.aborted) {
        await ensureLocalApi().shell.openExternal(url);
        return null;
      }
      cancelCallback(previous.url);
      // Native cancellation acknowledges abort before receive releases its listener and port.
      await previous.promise.catch(() => undefined);
    }
    if (signal.aborted) return null;
    if (receiver.current) return receiveCallback(url, signal);
    const receive = window.desktopBridge?.receiveProviderAuthCallback;
    if (!receive) return null;
    const active = { url, signal, promise: receive(url), cancelled: false };
    receiver.current = active;
    const abort = () => cancelCallback(url);
    signal.addEventListener("abort", abort, { once: true });
    try {
      const callbackUrl = await active.promise;
      return signal.aborted || active.cancelled ? null : callbackUrl;
    } finally {
      signal.removeEventListener("abort", abort);
      if (receiver.current === active) receiver.current = null;
    }
  };
  return { receiveCallback, cancelCallback };
}

export function readCodexReturnUrl(environmentId: EnvironmentId, instanceId: ProviderInstanceId) {
  const returnUrl = new URL(window.location.href);
  if (returnUrl.pathname === "/welcome") returnUrl.hash = `agents:${environmentId}`;
  if (returnUrl.pathname === "/settings/providers")
    returnUrl.searchParams.set("instanceId", instanceId);
  return returnUrl;
}
