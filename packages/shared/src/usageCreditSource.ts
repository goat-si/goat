import type { ProviderConsumeResetCreditInput, ServerProviderUsageLimits } from "@goat/contracts";

type CreditReport = {
  limits: ServerProviderUsageLimits;
  input: ProviderConsumeResetCreditInput | null;
};

export function creditReportWins(next: CreditReport, previous: CreditReport | null): boolean {
  if (!previous) return true;
  const kind = ({ input }: CreditReport) => (!input ? 0 : "sourceId" in input ? 2 : 1);
  const choosesGrant = ({ input, limits }: CreditReport) =>
    input !== null && "instanceId" in input && limits.resetCredits?.options !== undefined;
  const nextKind = kind(next);
  const previousKind = kind(previous);
  if (nextKind !== previousKind) {
    if (nextKind === 1 && previousKind === 2 && choosesGrant(next)) return true;
    if (nextKind === 2 && previousKind === 1 && choosesGrant(previous)) return false;
    return nextKind > previousKind;
  }
  return Date.parse(next.limits.checkedAt) > Date.parse(previous.limits.checkedAt);
}

export function shownCreditReport(selected: CreditReport | null, freshest: CreditReport | null) {
  if (selected?.input && "instanceId" in selected.input && selected.limits.resetCredits?.options)
    return selected.limits.resetCredits;
  const credits = freshest?.limits.resetCredits;
  if (!credits) return undefined;
  const { options: _options, ...balance } = credits;
  return balance;
}

export function newerCreditReport(next: CreditReport, previous: CreditReport | null) {
  return !previous || Date.parse(next.limits.checkedAt) > Date.parse(previous.limits.checkedAt);
}
