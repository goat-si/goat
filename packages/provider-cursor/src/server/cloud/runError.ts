// Cursor's reason tells the person what to fix, but its text can carry anything, so it is only
// classified here (on a bounded prefix, with plain phrase tests) and never shown. Phrases must
// stand alone, not inside a repository name or path, and a bare "upgrade" or "access" is not
// enough; anything unclear keeps the general sentence.
// A phrase sits between whitespace, the ends, or sentence punctuation; a period counts only when
// it ends the sentence. Anything joined to a name or path (".git", "/", "-", quotes) does not.
const ALONE = (phrases: string) =>
  new RegExp("(?<=^|[\\s,;:!?(])(?:" + phrases + ")(?=$|[\\s,;:!?)]|\\.(?:\\s|$))", "i");
const ACCOUNT_LIMIT = ALONE(
  [
    "(?:no|insufficient|not enough|out of)(?: usage)? credits?",
    "credit balance",
    // A bare quota can be a disk's; only an account's or plan's counts.
    "(?:usage|request|monthly|team|account|plan) quota (?:exceeded|reached)",
    "usage limit",
    "spend(?:ing)? limit",
    "plan limit",
    "billing (?:issue|problem|required|error)",
    "payment (?:required|failed|method)",
    "upgrade (?:your|to a) plan",
    "out of (?:usage|requests)",
  ].join("|"),
);
const ACCESS_REFUSED = ALONE(
  [
    "unauthori[sz]ed",
    "unauthenticated",
    "authenticat\\w{0,6}:? +(?:required|failed)",
    "not (?:signed|logged) in",
    "(?:sign|log)[- ]?in (?:required|again)",
    // Bare "permission denied", "forbidden" or "invalid key" also come from files, package
    // registries and ciphers; only a refusal naming the repository or an API key counts.
    "(?:permission|access) denied (?:to|for) (?:the |this )?(?:repository|repo|project)",
    "no access to (?:the |this )?(?:repository|repo|project|team|workspace)",
    "invalid api key",
  ].join("|"),
);

export function runErrorText(message: string | undefined) {
  const reason = message?.slice(0, 2000) ?? "";
  if (ACCOUNT_LIMIT.test(reason))
    return "Cursor stopped this run because of your Cursor account's usage or billing. Check your Cursor plan, then send the message again.";
  if (ACCESS_REFUSED.test(reason))
    return "Cursor stopped this run because it refused sign-in or access. Sign in to Cursor again and check repository access, then send the message again.";
  return "Cursor's agent hit an unexpected error before it finished.";
}
