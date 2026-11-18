import type { EnvironmentId } from "@goat/contracts";
import { useEnvironments } from "~/state/environments";

/**
 * Which environment a pairing link pairs with, and the others this app shows. A link is minted by
 * the environment it pairs with; the others need a link made on their own machine.
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
  // Names are unbounded: at most three, and the text scrolls inside a bounded height, so the
  // dialog's header never pushes its buttons off a phone screen.
  const list = new Intl.ListFormat("en").format(
    others.length > 3 ? [...others.slice(0, 3), `${others.length - 3} more`] : others,
  );
  return (
    <span className="block max-h-[25dvh] overflow-y-auto wrap-anywhere">
      Generate a one-time link that another device can use to pair with {label} as an authorized
      client.
      {others.length > 0
        ? ` This app also shows ${list}, which this link does not pair with. A link for ${others.length === 1 ? "it" : "one of those"} is created on the machine that runs it; see Manage or revoke access in the Remote access guide.`
        : null}
    </span>
  );
}
