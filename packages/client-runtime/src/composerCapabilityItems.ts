import {
  COMPUTER_USE_PROVIDER_DRIVERS,
  TURN_CAPABILITIES,
  type CuaHostStatus,
  type ProviderInteractionMode,
  type TurnCapability,
} from "@goat/contracts";
import { TURN_CAPABILITY_LABEL } from "@goat/shared/turnCapabilities";

/**
 * Whether a capability can run on the next turn. `checking` is not an answer yet, so picking
 * the entry does nothing; `unavailable` says why, and `setup` marks the ones the host's
 * Computer settings can fix.
 */
export type ComposerCapabilityAvailability =
  | { readonly state: "available"; readonly note: string | null }
  | { readonly state: "checking" }
  | { readonly state: "unavailable"; readonly reason: string; readonly setup: boolean };

/** An `@computer` / `@browser` entry in the composer's @ list. */
export interface ComposerCapabilityItem {
  readonly id: string;
  readonly type: "capability";
  readonly capability: TurnCapability;
  readonly label: string;
  readonly description: string;
  readonly availability: ComposerCapabilityAvailability;
}

export interface ComposerCapabilityContext {
  /** The host's computer use state; null while the first check runs. */
  readonly computerUse:
    | { readonly enabled: boolean; readonly status: CuaHostStatus }
    | { readonly error: string }
    | null;
  readonly interactionMode: ProviderInteractionMode;
  /** The driver of the provider the next turn goes to. */
  readonly providerDriver: string | null;
}

const DESCRIPTION: Record<TurnCapability, string> = {
  "computer-use": "See and use apps on this computer for this turn",
  browser: "Use the built-in browser for this turn",
};

const SEARCH_TERMS: Record<TurnCapability, ReadonlyArray<string>> = {
  "computer-use": ["computer", "computer use", "desktop", "screen", "apps"],
  browser: ["browser", "web", "preview"],
};

const AVAILABLE: ComposerCapabilityAvailability = { state: "available", note: null };

/**
 * The same gates the server applies when the turn starts, in the words a person needs to act
 * on them. Turns sent from the composer are attended, so the unattended lease does not apply;
 * a read-only sandbox is the provider's and is reported by the agent if it bites.
 */
export function turnCapabilityAvailability(
  capability: TurnCapability,
  context: ComposerCapabilityContext,
): ComposerCapabilityAvailability {
  if (capability === "browser") return AVAILABLE;
  if (context.interactionMode === "plan")
    return { state: "unavailable", reason: "Computer use is off in plan mode.", setup: false };
  if (context.providerDriver !== null && !COMPUTER_USE_PROVIDER_DRIVERS.has(context.providerDriver))
    return {
      state: "unavailable",
      reason: "This agent doesn't run on this computer, so it can't use computer use.",
      setup: false,
    };
  const computerUse = context.computerUse;
  if (computerUse === null) return { state: "checking" };
  if ("error" in computerUse)
    return {
      state: "unavailable",
      reason: `Couldn't check computer use on this host: ${computerUse.error}`,
      setup: true,
    };
  const { status, enabled } = computerUse;
  if (status.platform === "other")
    return {
      state: "unavailable",
      reason: "Computer use isn't available on this host.",
      setup: false,
    };
  if (status.display?.capability === "unavailable")
    return { state: "unavailable", reason: status.display.reason, setup: true };
  if (!enabled)
    return { state: "unavailable", reason: "Computer use is off for this host.", setup: true };
  // Limited support (missing grants, Wayland) still runs; the person sees the limit.
  return status.display?.capability === "partial"
    ? { state: "available", note: status.display.reason }
    : AVAILABLE;
}

/** Entries whose name or a search term starts with the typed query; all of them for a bare @. */
export function matchComposerCapabilityItems(
  query: string,
  context: ComposerCapabilityContext,
): ComposerCapabilityItem[] {
  const normalized = query.trim().toLowerCase();
  return TURN_CAPABILITIES.filter(
    (capability) =>
      normalized.length === 0 ||
      SEARCH_TERMS[capability].some((term) => term.startsWith(normalized)),
  ).map((capability) => ({
    id: `capability:${capability}`,
    type: "capability",
    capability,
    label: TURN_CAPABILITY_LABEL[capability],
    description: DESCRIPTION[capability],
    availability: turnCapabilityAvailability(capability, context),
  }));
}

/** The line an entry shows under its name. */
export function composerCapabilityDetail(item: ComposerCapabilityItem): string {
  switch (item.availability.state) {
    case "available":
      return item.availability.note ?? item.description;
    case "checking":
      return "Checking this host…";
    case "unavailable":
      return item.availability.reason;
  }
}
