import {
  TURN_CAPABILITIES,
  type CuaHostStatus,
  type ProviderInteractionMode,
  type TurnCapability,
} from "@goat/contracts";
import { TURN_CAPABILITY_LABEL } from "@goat/shared/turnCapabilities";

/** An `@computer` / `@browser` entry in the composer's @ list. */
export interface ComposerCapabilityItem {
  readonly id: string;
  readonly type: "capability";
  readonly capability: TurnCapability;
  readonly label: string;
  readonly description: string;
  /** Why the capability cannot run on this turn; picking the entry opens setup instead. */
  readonly unavailableReason: string | null;
}

export interface ComposerCapabilityContext {
  /** The environment's computer use state; null while it loads or when it cannot be read. */
  readonly computerUse: { readonly enabled: boolean; readonly status: CuaHostStatus | null } | null;
  readonly interactionMode: ProviderInteractionMode;
}

const DESCRIPTION: Record<TurnCapability, string> = {
  "computer-use": "See and use apps on this computer for this turn",
  browser: "Use the built-in browser for this turn",
};

const SEARCH_TERMS: Record<TurnCapability, ReadonlyArray<string>> = {
  "computer-use": ["computer", "computer use", "desktop", "screen", "apps"],
  browser: ["browser", "web", "preview"],
};

/**
 * Why a capability cannot run, in the words a person needs to fix it. The server applies the
 * same gates again when the turn starts; this only keeps the entry honest before sending.
 */
export function turnCapabilityUnavailableReason(
  capability: TurnCapability,
  context: ComposerCapabilityContext,
): string | null {
  if (capability === "browser") return null;
  if (context.interactionMode === "plan") return "Computer use is off in plan mode.";
  const computerUse = context.computerUse;
  if (computerUse === null) return "Checking computer use on this host…";
  if (computerUse.status?.platform === "other") return "Computer use isn't available on this host.";
  if (computerUse.status?.display?.capability === "unavailable")
    return computerUse.status.display.reason;
  if (!computerUse.enabled) return "Computer use is off for this host. Set it up to use it.";
  return null;
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
    unavailableReason: turnCapabilityUnavailableReason(capability, context),
  }));
}
