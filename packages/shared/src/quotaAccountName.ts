/**
 * A pool account's name for people. OpenCodex never reports an email for pool accounts, only a
 * privacy label such as `p61e549` and the plan, so the name is built from those; the opaque
 * `accountRef` is cut to a short tag only when no label exists.
 */
export function quotaPoolAccountName(account: {
  readonly label?: string | undefined;
  readonly plan?: string | undefined;
  readonly accountRef?: string | undefined;
}): string {
  const plan = account.plan?.trim();
  const title = plan ? `${plan[0]?.toUpperCase() ?? ""}${plan.slice(1)} account` : "Account";
  const ref = account.accountRef?.replace(/^acct_/, "").slice(0, 6);
  const handle = account.label?.trim() || (ref ? `#${ref}` : undefined);
  return handle ? `${title} · ${handle}` : title;
}

/** The accountRef inside a GOAT source account id, which is JSON [homeId, provider, accountRef]. */
export function accountRefOfSourceId(id: string): string | undefined {
  if (!id.startsWith("[")) return undefined;
  try {
    const parsed: unknown = JSON.parse(id);
    return Array.isArray(parsed) && typeof parsed[2] === "string" ? parsed[2] : undefined;
  } catch {
    return undefined;
  }
}
