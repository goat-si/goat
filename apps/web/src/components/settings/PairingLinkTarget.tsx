import type { EnvironmentId } from "@goat/contracts";
import { useEnvironments } from "~/state/environments";

/**
 * Which environment a pairing link pairs with, and the others this app shows. A link is minted by
 * the environment it pairs with; the others need their own link, made on their own machine.
 */
export function PairingLinkTarget({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  const { environments } = useEnvironments();
  const label =
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    "this backend";
  const others = environments
    .filter(
      (environment) => environment.entry.enabled && environment.environmentId !== environmentId,
    )
    .map((environment) => environment.label);
  // At most three names, so many environments cannot push the dialog's header off a phone screen.
  const list = new Intl.ListFormat("en").format(
    others.length > 3 ? [...others.slice(0, 3), `${others.length - 3} more`] : others,
  );
  return (
    <span className="wrap-anywhere">
      Generate a one-time link that another device can use to pair with {label} as an authorized
      client.
      {others.length > 0
        ? ` This app also shows ${list}, which this link does not pair with. To pair a device with ${others.length === 1 ? "it" : "one of those"}, run goat pair on the machine that runs it; that link gets Standard permissions, whatever you choose here, unless you add --scope (see Manage or revoke access in the Remote access guide).`
        : null}
    </span>
  );
}
