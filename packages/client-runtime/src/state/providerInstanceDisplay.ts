import {
  defaultInstanceIdForDriver,
  HandoffError,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ServerProvider,
} from "@goat/contracts";
import * as Schema from "effect/Schema";

function humanizeSlug(slug: string): string {
  return slug
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

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

export function providerInstanceInitials(label: string): string {
  const words = label.replace(/[_-]+/g, " ").split(/\s+/u).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return Array.from(words[0]!).slice(0, 2).join("").toUpperCase();
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0]?.toUpperCase() ?? "")
    .join("");
}

export function normalizeProviderAccentColor(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return /^#[0-9a-fA-F]{6}$/u.test(trimmed) ? trimmed : undefined;
}

export function providerAccentForegroundColor(accentColor: string) {
  const linearChannel = (offset: number) => {
    const value = Number.parseInt(accentColor.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * linearChannel(1) + 0.7152 * linearChannel(3) + 0.0722 * linearChannel(5);
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);
  return blackContrast >= whiteContrast ? "#000000" : "#ffffff";
}

export function shouldShowInstanceBadge(
  entry: {
    readonly driverKind: ProviderDriverKind;
    readonly accentColor?: string | undefined;
    readonly acpRegistryAgentId?: string | undefined;
    readonly enabled: boolean;
  },
  entries: Iterable<{
    readonly driverKind: ProviderDriverKind;
    readonly acpRegistryAgentId?: string | undefined;
    readonly enabled: boolean;
  }>,
): boolean {
  if (entry.accentColor) return true;
  let sharedProviderCount = 0;
  for (const candidate of entries) {
    if (candidate.driverKind !== entry.driverKind) continue;
    // Historical threads still need to distinguish accounts that are all disabled.
    if (entry.enabled && !candidate.enabled) continue;
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

const isHandoffError = Schema.is(HandoffError);

/**
 * What a person is told when their answer to a handoff fails. An approved provider change that
 * failed, or may have landed, says which, so nobody approves a half-applied change again; a
 * conflict the server explained, such as another thread holding an app, says what is in the way.
 */
export function handoffRespondErrorMessage(error: unknown): string {
  return isHandoffError(error) &&
    (error.outcome !== undefined || (error.reason === "conflict" && error.detail !== undefined))
    ? error.message
    : "Could not update this handoff. It may already be resolved or expired.";
}
