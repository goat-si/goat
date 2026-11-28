let cachedReader: (() => boolean) | undefined;
let cachedDisabled = false;

/**
 * The local-environment setting only changes across a relaunch; memoize per bridge
 * function reference so repeated atom updates do not trigger synchronous IPC.
 */
export function isLocalEnvironmentDisabled(): boolean {
  const reader = window.desktopBridge?.getLocalEnvironmentEnabled;
  if (reader === undefined) {
    cachedReader = undefined;
    cachedDisabled = false;
    return false;
  }
  if (reader === cachedReader) {
    return cachedDisabled;
  }
  const disabled = reader() === false;
  cachedReader = reader;
  cachedDisabled = disabled;
  return disabled;
}
