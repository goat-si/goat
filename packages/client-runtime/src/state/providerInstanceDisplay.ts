import {
  defaultInstanceIdForDriver,
  HandoffError,
  PROVIDER_DISPLAY_NAMES,
  type CodexRouteStatus,
  type ProviderDriverKind,
  type ServerProvider,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
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
  // Punctuation separates words so "Codex (hub)" reads CH, not C(. An apostrophe
  // inside a word stays ("Theo's Codex" is TC); a quoting one does not
  // ("Codex 'hub'" is CH).
  const words = label
    .replace(/[^\P{P}'’]+/gu, " ")
    .split(/\s+/u)
    .map((word) => word.replace(/^['’]+|['’]+$/gu, ""))
    .filter(Boolean);
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

/** The four adapters with an explicit Home route; every other provider keeps its own sign-in. */
export function supportsProviderHome(driver: string): boolean {
  return driver === "codex" || driver === "claudeAgent" || driver === "opencode" || driver === "pi";
}

/** A provider's observed Home route. It reports configuration, never a verified request. */
export function providerHomeRouteSummary(
  provider: Pick<ServerProvider, "driver" | "homeRoute" | "codexRoute">,
): string | undefined {
  if (provider.driver === "codex") return openCodexRouteSummary(provider.codexRoute);
  if (!supportsProviderHome(provider.driver) || provider.homeRoute === undefined) return undefined;
  return provider.homeRoute.modelRoute === "opencodex"
    ? `Uses OpenCodex Home · ${provider.homeRoute.effectiveBaseUrl ?? "Endpoint not verified"}`
    : "Uses the provider's own settings";
}

/**
 * Whether a routed instance's machine still needs its Home link set up from Home's Hub devices:
 * Codex reports a missing or failed link, and the other adapters report a route only once their
 * Home runtime was prepared.
 */
export function providerHomeNeedsSetup(
  driver: string,
  route: Pick<CodexRouteStatus, "modelRoute" | "state"> | undefined,
): boolean {
  if (driver === "codex") return route?.state === "not_linked" || route?.state === "failed";
  return supportsProviderHome(driver) && route?.modelRoute !== "opencodex";
}

export function openCodexHomeHandoff(input: {
  readonly environmentLabel: string;
  readonly action: "connect" | "disconnect";
}): { readonly title: string; readonly instruction: string } {
  return input.action === "connect"
    ? {
        title: "Set up from Home",
        instruction: `Open Hub devices on your Home and add ${input.environmentLabel}. GOAT installs OpenCodex there, links it, and verifies one request through Home.`,
      }
    : {
        title: "Stop using OpenCodex Home",
        instruction: `This instance goes back to its provider's own settings and may need its own sign-in on ${input.environmentLabel}. OpenCodex stays linked to Home; remove the device in Home's Hub devices to end the link.`,
      };
}

export const CODEX_ROUTE_BUSY_MESSAGE =
  "Wait for this instance's active turns to finish before changing its model route.";
const CODEX_ROUTE_STALE_MESSAGE = "Settings changed on another device. Review them and try again.";

export function codexRouteErrorMessage(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  if (code === "provider_instance_busy") return CODEX_ROUTE_BUSY_MESSAGE;
  if (code === "provider_instance_stale") return CODEX_ROUTE_STALE_MESSAGE;
  return error instanceof Error
    ? error.message
    : "Could not update the model route. Check status and try again.";
}

const isHandoffError = Schema.is(HandoffError);

/**
 * When a pending handoff expires, in the reader's own time to the minute. Near a change of the
 * zone's UTC offset (any size: clocks fall back 30 minutes on Lord Howe, two hours at Troll) the
 * same wall time can mean two instants, so the label then names the zone. An expiry is always
 * ahead of its request, and current tz data changes no offset by more than two hours, so three
 * hours either side catch every repeated time. Locale and zone default to the reader's; tests pin
 * them.
 */
export function handoffExpiryLabel(
  expiresAt: DateTime.Utc,
  options: { readonly locale?: string; readonly timeZone?: string } = {},
): string {
  const at = DateTime.toEpochMillis(expiresAt);
  const zone = options.timeZone === undefined ? {} : { timeZone: options.timeZone };
  const offsets = new Intl.DateTimeFormat("en-US", { ...zone, timeZoneName: "longOffset" });
  const offset = (ms: number) =>
    offsets.formatToParts(ms).find((part) => part.type === "timeZoneName")?.value;
  const changes = [at - 3 * 3_600_000, at + 3 * 3_600_000].some((ms) => offset(ms) !== offset(at));
  const clock = new Intl.DateTimeFormat(options.locale, {
    hour: "numeric",
    minute: "2-digit",
    ...zone,
    ...(changes ? { timeZoneName: "short" } : {}),
  });
  return `Expires ${clock.format(at)}`;
}

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
