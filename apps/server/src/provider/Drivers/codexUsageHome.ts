import type { ServerProviderDraft } from "@goat/provider-core/server/snapshotProbe";

/**
 * The limits a check may publish. Same home as the published snapshot: unchanged. Another home: a
 * failed read is dropped (it would keep that home's limits) and a successful one is dated now
 * (windows that home's sessions reported would look newer). A home that moved during the check:
 * nothing, since GOAT cannot tell which home the read came from.
 */
export const withoutOtherHomeUsage = (
  status: ServerProviderDraft,
  home: "same" | "other" | "unknown",
  now: string,
): ServerProviderDraft => {
  if (home === "same" || status.usageLimits === undefined) return status;
  const { usageLimits, ...rest } = status;
  if (home === "unknown" || usageLimits.unavailable?.reason === "probeFailed") return rest;
  return { ...rest, usageLimits: { ...usageLimits, checkedAt: now } };
};
