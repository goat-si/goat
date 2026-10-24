import type { AuthEnvironmentScope } from "@goat/contracts";

export function providerThreadScopes(
  usableThread: boolean,
  readOnly: boolean,
  dispatchScopes: ReadonlyArray<AuthEnvironmentScope> | undefined,
): ReadonlyArray<AuthEnvironmentScope> {
  if (!usableThread) return [];
  const scopes: ReadonlyArray<AuthEnvironmentScope> = readOnly
    ? ["orchestration:read"]
    : ["orchestration:read", "orchestration:operate"];
  // An explicit dispatch grant is a ceiling, never authority to approve as a person.
  return dispatchScopes === undefined
    ? scopes
    : scopes.filter((scope) => dispatchScopes.includes(scope));
}
