import type { ServerProvider, ServerProviderUsageLimits } from "@goat/contracts";

function accountKey(
  driver: ServerProvider["driver"],
  email: string | undefined,
  limits?: ServerProviderUsageLimits,
): string | null {
  const normalizedEmail = email?.trim().toLowerCase();
  if (normalizedEmail) return `${driver}:${normalizedEmail}`;
  return limits?.credentialFingerprint
    ? `${driver}:credential:${limits.credentialFingerprint}`
    : null;
}

interface AccountReport {
  readonly driver: ServerProvider["driver"];
  readonly email?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly usageLimits?: ServerProviderUsageLimits | undefined;
}

export const nativeReport = (provider: ServerProvider): AccountReport => ({
  driver: provider.driver,
  email: provider.auth.email,
  workspaceId: provider.auth.workspaceId,
  usageLimits: provider.usageLimits,
});

// Include every enabled login, even unreadable workspaces.
export function accountKeyResolver(reports: Iterable<AccountReport>) {
  const workspaces = new Map<string, Set<string>>();
  for (const report of reports) {
    const key = accountKey(report.driver, report.email, report.usageLimits);
    if (key && report.workspaceId) {
      workspaces.set(key, (workspaces.get(key) ?? new Set()).add(report.workspaceId));
    }
  }
  return (report: AccountReport): string | null => {
    const key = accountKey(report.driver, report.email, report.usageLimits);
    if (!key) return null;
    if (report.workspaceId) return `${key}:${report.workspaceId}`;
    const known = workspaces.get(key);
    if (!known) return key;
    return known.size === 1 ? `${key}:${[...known][0]}` : null;
  };
}

export const hubAccountName = (account: { readonly id: string }) =>
  account.id.replace(/\.json$/i, "");

/** Pool quota, or a pool GOAT could not read: never the instance's own login. */
export const routedThroughOpenCodex = (limits: ServerProviderUsageLimits) =>
  limits.quotaPool !== undefined || limits.quotaPoolRoute !== undefined;

/** A routed instance's own login as usage limits, and whether its driver can redeem there. */
export function localLimits(limits: ServerProviderUsageLimits) {
  const own = limits.localAccount;
  if (own === undefined) return undefined;
  return {
    redeemable: own.redeemable,
    limits: {
      checkedAt: own.checkedAt,
      windows: own.windows,
      ...(own.resetCredits === undefined ? {} : { resetCredits: own.resetCredits }),
      ...(own.credentialFingerprint === undefined
        ? {}
        : { credentialFingerprint: own.credentialFingerprint }),
    } satisfies ServerProviderUsageLimits,
  };
}

export function limitsNotice(limits: ServerProviderUsageLimits): string | null {
  if (limits.unavailable?.reason === "unsupported") {
    return limits.unavailable.message ?? "This account has no subscription limits.";
  }
  if (limits.unavailable?.reason === "probeFailed") {
    return limits.unavailable.message ?? "Could not read limits.";
  }
  const blocks = limits.availability?.some((block) => block.exhausted) === true;
  return limits.windows.length === 0 && !blocks && !limits.zeroSpendCap
    ? "No limits reported."
    : null;
}
