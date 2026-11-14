import type { ServerProviderDraft } from "@goat/provider-core/server/snapshotProbe";

/**
 * A check under another home than the published snapshot's must not carry that home's limits
 * forward: a failed read would keep them, and windows a session reported meanwhile would look newer
 * than this read. Same home: unchanged.
 */
export const withoutOtherHomeUsage = (
  status: ServerProviderDraft,
  homeChanged: boolean,
  now: string,
): ServerProviderDraft => {
  if (!homeChanged || status.usageLimits === undefined) return status;
  const { usageLimits, ...rest } = status;
  return usageLimits.unavailable?.reason === "probeFailed"
    ? rest
    : { ...rest, usageLimits: { ...usageLimits, checkedAt: now } };
};
