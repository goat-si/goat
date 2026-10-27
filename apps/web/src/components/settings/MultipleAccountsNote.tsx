import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderDriverKind } from "@goat/contracts";
import { InfoIcon } from "~/components/solar";

import { serverEnvironment } from "../../state/server";
import { Alert, AlertDescription } from "../ui/alert";

const ACCOUNT_GUIDANCE = new Map([
  ["codex", { name: "Codex", guide: "providers-codex.md#use-multiple-accounts" }],
  [
    "claudeAgent",
    { name: "Claude", guide: "providers-claude.md#separate-accounts-or-configurations" },
  ],
]);

export function MultipleAccountsNote({
  environmentId,
  driver,
}: {
  readonly environmentId: EnvironmentId;
  readonly driver: ProviderDriverKind;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const guidance = ACCOUNT_GUIDANCE.get(driver);
  if (
    !guidance ||
    !providers?.some(
      (provider) => provider.driver === driver && provider.auth.status === "authenticated",
    )
  )
    return null;
  return (
    <Alert variant="info" role="note">
      <InfoIcon aria-hidden />
      <AlertDescription>
        <p>
          GOAT supports separate {guidance.name} accounts. Before adding another, check which
          account is already signed in and keep each account's sign-in separate. Adding an account
          does not increase another account's usage limits.{" "}
          <a
            href={`https://github.com/goat-si/goat/blob/dev/docs/user/${guidance.guide}`}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            Multi-account guidance
          </a>
        </p>
      </AlertDescription>
    </Alert>
  );
}
