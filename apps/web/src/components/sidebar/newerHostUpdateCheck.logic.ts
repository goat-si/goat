import { compareRuntimeBuilds } from "@goat/shared/semver";

/**
 * A connected host on a newer GOAT usually means this app's channel already
 * published that build, so the app checks now instead of waiting for its next
 * poll. Each newer host version starts one check; the update control shows the
 * outcome, including a failed check.
 */
export function createNewerHostUpdateCheck(appVersion: string, checkForUpdate: () => void) {
  const checkedVersions = new Set<string>();
  return (hostVersion: string | null | undefined): boolean => {
    if (!hostVersion || checkedVersions.has(hostVersion)) return false;
    const order = compareRuntimeBuilds({ version: hostVersion }, { version: appVersion });
    if (order === undefined || order <= 0) return false;
    checkedVersions.add(hostVersion);
    checkForUpdate();
    return true;
  };
}
