// Cursor's reason tells the person what to fix, but its text can carry anything, so it is only
// classified here (on a bounded prefix, with plain keyword tests) and never shown.
// Specific phrases only: a bare "upgrade" or "access" also appears in transport errors, which
// keep the general sentence.
const ACCOUNT_LIMIT =
  /credits?\b|quota|billing|payment|usage limit|spend(?:ing)? limit|plan limit|upgrade (?:your|to a) plan|out of (?:usage|requests)/i;
const ACCESS_REFUSED =
  /unauthori[sz]ed|unauthenticated|authenticat\w{0,6}\W{0,3}(?:required|failed)|not (?:signed|logged) in|(?:sign|log)[- ]?in (?:required|again)|permission denied|forbidden|access denied|no access|invalid (?:api )?key/i;

export function runErrorText(message: string | undefined) {
  const reason = message?.slice(0, 2000) ?? "";
  if (ACCOUNT_LIMIT.test(reason))
    return "Cursor stopped this run because of your Cursor account's usage or billing. Check your Cursor plan, then send the message again.";
  if (ACCESS_REFUSED.test(reason))
    return "Cursor stopped this run because it refused sign-in or access. Sign in to Cursor again and check repository access, then send the message again.";
  return "Cursor's agent hit an unexpected error before it finished.";
}
