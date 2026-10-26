import {
  COMPUTER_USE_PROVIDER_DRIVERS,
  type ComputerUseApp,
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

/** An `@computer` / `@browser` entry in the composer's @ list, or an `@Finder` app entry. */
export interface ComposerCapabilityItem {
  readonly id: string;
  readonly type: "capability";
  readonly capability: TurnCapability;
  readonly label: string;
  readonly description: string;
  readonly availability: ComposerCapabilityAvailability;
  /** Set for a running app: picking it asks for computer use aimed at that app. */
  readonly app?: ComputerUseApp;
}

/** Most app entries one @ list shows; typing narrows the rest. */
export const COMPOSER_APP_ITEM_LIMIT = 30;

export interface ComposerCapabilityContext {
  /** The host's computer use state; null while the first check runs. */
  readonly computerUse:
    | { readonly enabled: boolean; readonly status: CuaHostStatus }
    | { readonly error: string }
    | null;
  readonly interactionMode: ProviderInteractionMode;
  /** The drivers of every provider the next send goes to; more than one when it fans out. */
  readonly providerDrivers: ReadonlyArray<string>;
  /**
   * The thread may run unattended (a channel worker, or a task another agent started), where
   * the server attaches computer use only after a person approves it.
   */
  readonly mayRunUnattended: boolean;
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
 * on them. A read-only sandbox is the provider's and is reported by the agent if it bites.
 */
export function turnCapabilityAvailability(
  capability: TurnCapability,
  context: ComposerCapabilityContext,
): ComposerCapabilityAvailability {
  if (capability === "browser") return AVAILABLE;
  if (context.interactionMode === "plan")
    return { state: "unavailable", reason: "Computer use is off in plan mode.", setup: false };
  const supported = context.providerDrivers.filter((driver) =>
    COMPUTER_USE_PROVIDER_DRIVERS.has(driver),
  ).length;
  if (context.providerDrivers.length > 0 && supported === 0)
    return {
      state: "unavailable",
      reason:
        context.providerDrivers.length === 1
          ? "This agent doesn't run on this computer, so it can't use computer use."
          : "None of the selected agents run on this computer, so they can't use computer use.",
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
  // Limited support (missing grants, Wayland) still runs; the person sees each limit.
  const notes = [
    status.display?.capability === "partial" ? status.display.reason : null,
    supported < context.providerDrivers.length
      ? "Some selected agents can't use it and will say so."
      : null,
    context.mayRunUnattended
      ? "This thread can run unattended, so a person approves computer use first."
      : null,
  ].filter((note) => note !== null);
  return notes.length === 0 ? AVAILABLE : { state: "available", note: notes.join(" ") };
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

/**
 * The host's running apps as @ entries: only while `@computer` itself can run (an app entry is
 * computer use aimed at one app), matched by a name or id that starts with the query or a word
 * of the name that does, sorted by name and capped at COMPOSER_APP_ITEM_LIMIT.
 */
export function matchComposerAppItems(
  query: string,
  context: ComposerCapabilityContext,
  apps: ReadonlyArray<ComputerUseApp>,
): ComposerCapabilityItem[] {
  const availability = turnCapabilityAvailability("computer-use", context);
  if (availability.state !== "available") return [];
  const normalized = query.trim().toLowerCase();
  const matches = (app: ComputerUseApp) => {
    if (normalized.length === 0) return true;
    const name = app.name.toLowerCase();
    return (
      name.startsWith(normalized) ||
      name.split(/[\s._-]+/).some((word) => word.startsWith(normalized)) ||
      app.id.toLowerCase().startsWith(normalized)
    );
  };
  return [...apps]
    .filter(matches)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    .slice(0, COMPOSER_APP_ITEM_LIMIT)
    .map((app) => ({
      id: `app:${app.id}`,
      type: "capability" as const,
      capability: "computer-use" as const,
      label: app.name,
      description: `Use ${app.name} with computer use for this turn`,
      availability,
      app,
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

/**
 * Whether a thread's turns may count as unattended on the server: a channel worker, a thread
 * another agent launched (here or from another machine), or a task an agent delegated. A person
 * promoting a task does not count. The server decides from the run's own history; this only
 * says "maybe" so the entry can warn before sending.
 */
export function composerThreadMayRunUnattended(
  threadId: string | null,
  thread:
    | {
        readonly lineage: { readonly relationshipToParent: "fork" | "subagent" | null };
        readonly launchedBy?: { readonly kind: "launch" | "promotion" } | undefined;
      }
    | undefined,
): boolean {
  return (
    threadId?.startsWith("channel-worker:") === true ||
    thread?.launchedBy?.kind === "launch" ||
    thread?.lineage.relationshipToParent === "subagent"
  );
}
