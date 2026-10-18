/**
 * How a configured provider instance presents itself in a client: its label,
 * its accent color, and whether its icon carries the account badge. Shared by
 * web and mobile so both clients name and badge the same instance identically.
 *
 * @module providerInstanceDisplay
 */
import {
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ServerProvider,
} from "@goat/contracts";

/**
 * Title-case a slug: splits on `_` / `-` and camelCase boundaries, so
 * `codex_personal` becomes "Codex Personal" and `myCustomInstance` becomes
 * "My Custom Instance".
 */
function humanizeSlug(slug: string): string {
  return slug
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Resolve an instance's label with a tiered priority:
 *
 *   1. A snapshot `displayName` that differs from the driver's brand label —
 *      the server has explicitly named this instance, trust it.
 *   2. For non-default instances, a humanized `instanceId` — the server fell
 *      back to the driver-level label (the same for every instance of that
 *      kind), so the slug is what keeps "Codex" and "Codex Personal" apart.
 *   3. The snapshot's `displayName`, or the brand label from contracts.
 */
export function resolveProviderInstanceDisplayName(
  snapshot: Pick<ServerProvider, "instanceId" | "driver" | "displayName" | "codexRoute">,
): string {
  const trimmedSnapshotName = snapshot.displayName?.trim();
  const kindLabel = PROVIDER_DISPLAY_NAMES[snapshot.driver] ?? humanizeSlug(snapshot.driver);
  const label =
    trimmedSnapshotName && trimmedSnapshotName !== kindLabel
      ? trimmedSnapshotName
      : snapshot.instanceId !== defaultInstanceIdForDriver(snapshot.driver)
        ? humanizeSlug(snapshot.instanceId) || trimmedSnapshotName || kindLabel
        : trimmedSnapshotName || kindLabel;
  return snapshot.driver === "codex" &&
    snapshot.codexRoute?.modelRoute === "opencodex" &&
    !label.endsWith("OpenCodex Home")
    ? `${label} · OpenCodex Home`
    : label;
}

/**
 * Turn a display name into up to two initials for the badge: the first two
 * characters of a single word, or the first character of each of the first
 * two words. Iterates by code point so an emoji never splits into surrogates.
 */
export function providerInstanceInitials(label: string): string {
  const words = label.replace(/[_-]+/g, " ").split(/\s+/u).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return Array.from(words[0]!).slice(0, 2).join("").toUpperCase();
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0]?.toUpperCase() ?? "")
    .join("");
}

/** Only `#rrggbb` accent colors render; anything else is treated as unset. */
export function normalizeProviderAccentColor(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return /^#[0-9a-fA-F]{6}$/u.test(trimmed) ? trimmed : undefined;
}

/**
 * Whether an instance's icon carries the account badge: accent color set, or
 * several instances sharing a provider so the brand glyph alone is ambiguous.
 * ACP agents have distinct glyphs even though they share the registry driver.
 * Shared by the composer trigger, the picker rail, and sidebar/thread rows.
 */
export function shouldShowInstanceBadge(
  entry: {
    readonly driverKind: ProviderDriverKind;
    readonly accentColor?: string | undefined;
    readonly acpRegistryAgentId?: string | undefined;
  },
  entries: Iterable<{
    readonly driverKind: ProviderDriverKind;
    readonly acpRegistryAgentId?: string | undefined;
  }>,
): boolean {
  if (entry.accentColor) return true;
  let sharedProviderCount = 0;
  for (const candidate of entries) {
    if (candidate.driverKind !== entry.driverKind) continue;
    if (
      entry.driverKind === "acpRegistry" &&
      candidate.acpRegistryAgentId !== entry.acpRegistryAgentId
    ) {
      continue;
    }
    if (++sharedProviderCount > 1) return true;
  }
  return false;
}

/** Observed route status; a missing snapshot never implies a working Home link. */
export function openCodexRouteSummary(route: ServerProvider["codexRoute"]): string | undefined {
  if (!route) return undefined;
  if (route.modelRoute === "default") {
    return `Uses Codex's own settings · ${route.effectiveBaseUrl ?? "Endpoint not verified"}`;
  }
  switch (route.state) {
    case "connected":
      return route.homeLabel ? `Home connected (${route.homeLabel})` : "Home connected";
    case "home":
      return "This machine is your OpenCodex Home.";
    case "reconnecting":
      return "Reconnecting to Home…";
    case "failed":
      return `Home link failed: ${route.reason ?? "Check OpenCodex and try again."}`;
    case "not_linked":
      return "Not linked to Home.";
    case "not_running":
      return "OpenCodex isn't running on this machine.";
    default:
      return "OpenCodex Home status not checked. Check status.";
  }
}

export function openCodexHomeHandoff(input: {
  readonly environmentLabel: string;
  readonly action: "connect" | "disconnect";
}): { readonly title: string; readonly instruction: string; readonly command?: string } {
  return input.action === "connect"
    ? {
        title: "Connect to Home",
        instruction: `On ${input.environmentLabel}, open a terminal and complete OpenCodex's Remote Link setup for this host. Then return here and check status.`,
      }
    : {
        title: "Stop using OpenCodex Home",
        instruction: `This instance goes back to Codex's own settings. OpenCodex stays connected to Home; run ocx disconnect on ${input.environmentLabel} to disconnect it.`,
        command: "ocx disconnect",
      };
}

export const CODEX_ROUTE_BUSY_MESSAGE =
  "Wait for this instance's active turns to finish before changing its model route.";

export function codexRouteErrorMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "provider_instance_busy"
  )
    return CODEX_ROUTE_BUSY_MESSAGE;
  return error instanceof Error
    ? error.message
    : "Could not update the model route. Check status and try again.";
}
