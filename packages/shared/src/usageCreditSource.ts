import type { ProviderConsumeResetCreditInput, ServerProviderUsageLimits } from "@goat/contracts";

type CreditReport = {
  limits: ServerProviderUsageLimits;
  input: ProviderConsumeResetCreditInput | null;
};

export function creditReportWins(next: CreditReport, previous: CreditReport | null): boolean {
  if (!previous) return true;
  const rank = ({ limits, input }: CreditReport) =>
    !input
      ? 0
      : "instanceId" in input && limits.resetCredits?.options
        ? 3
        : "sourceId" in input
          ? 2
          : 1;
  return rank(next) !== rank(previous)
    ? rank(next) > rank(previous)
    : Date.parse(next.limits.checkedAt) > Date.parse(previous.limits.checkedAt);
}
