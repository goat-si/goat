export type DestinationId =
  | "home"
  | "fleet"
  | "bot"
  | "decisions"
  | "usage"
  | "pullRequests"
  | "memory"
  | "scheduled"
  | "hub"
  | "notes"
  | "settings";

/** Rail width in CSS pixels; the shell also subtracts it from the sidebar's width limits. */
export const DESTINATION_RAIL_WIDTH_PX = 56;

const isWithin = (pathname: string, base: string) =>
  pathname === base || pathname.startsWith(`${base}/`);

/**
 * Picks the rail destination for a URL. `isBotRoute` comes from `isGoatBotRoute`, because
 * /bot redirects to the bot's own thread URL, which would otherwise read as Home.
 */
export function resolveActiveDestination(
  pathname: string,
  context: { readonly isBotRoute: boolean },
): DestinationId {
  if (context.isBotRoute) return "bot";
  if (pathname === "/fleet") return "fleet";
  if (pathname === "/decisions") return "decisions";
  if (pathname === "/usage") return "usage";
  if (pathname === "/pull-requests") return "pullRequests";
  if (pathname === "/notes") return "notes";
  if (isWithin(pathname, "/settings/memory")) return "memory";
  if (isWithin(pathname, "/settings/scheduled-tasks")) return "scheduled";
  if (isWithin(pathname, "/settings/hub")) return "hub";
  if (isWithin(pathname, "/settings") || pathname.startsWith("/projects/")) return "settings";
  return "home";
}

/** Rail items a person can show, hide, and reorder, in their default order. Home and Settings stay pinned. */
export const RAIL_ITEM_IDS = [
  "fleet",
  "bot",
  "decisions",
  "usage",
  "pullRequests",
  "memory",
  "scheduled",
  "hub",
  "notes",
  "addProvider",
] as const;
export type RailItemId = (typeof RAIL_ITEM_IDS)[number];

const RAIL_ITEM_ID_SET: ReadonlySet<string> = new Set(RAIL_ITEM_IDS);
const isRailItemId = (id: string): id is RailItemId => RAIL_ITEM_ID_SET.has(id);

/** Mirrors the `destinationRail` client setting. Ids are plain strings so other app versions' ids survive. */
export interface RailPreferences {
  readonly order: ReadonlyArray<string>;
  readonly shown: ReadonlyArray<string>;
  readonly hidden: ReadonlyArray<string>;
}

export const DEFAULT_RAIL_PREFERENCES: RailPreferences = { order: [], shown: [], hidden: [] };

export interface RailContext {
  /** Saved environments, connected or not, so a dropped connection does not reshuffle the rail. */
  readonly environmentCount: number;
  readonly pullRequestsSupported: boolean;
  readonly memoryAvailable: boolean;
  readonly hubEnabled: boolean;
  /** A primary environment exists and this session may manage its providers. */
  readonly canAddProvider: boolean;
  /** Whether the primary environment has a ready provider; null until its providers load. */
  readonly primaryProviderReady: boolean | null;
}

export type RailChoice = "default" | "shown" | "hidden";

export interface ResolvedRailItem {
  readonly id: RailItemId;
  readonly shown: boolean;
  readonly available: boolean;
  readonly choice: RailChoice;
  readonly defaultShown: boolean;
}

function isAvailable(id: RailItemId, context: RailContext): boolean {
  switch (id) {
    case "pullRequests":
      return context.pullRequestsSupported;
    case "memory":
      return context.memoryAvailable;
    case "addProvider":
      return context.canAddProvider;
    default:
      return true;
  }
}

/** Context decides only what a person has not chosen; an explicit choice always wins. */
function isShownByDefault(id: RailItemId, context: RailContext): boolean {
  switch (id) {
    case "fleet":
      return context.environmentCount > 1;
    case "hub":
      return context.hubEnabled;
    case "addProvider":
      // Unknown readiness stays hidden so the item does not flash in while providers load.
      return context.primaryProviderReady === false;
    default:
      return true;
  }
}

/** Saved order first (unknown and repeated ids dropped), then any remaining items in default order. */
export function orderRailItems(order: ReadonlyArray<string>): RailItemId[] {
  const ordered = new Set<RailItemId>();
  for (const id of order) if (isRailItemId(id)) ordered.add(id);
  for (const id of RAIL_ITEM_IDS) ordered.add(id);
  return [...ordered];
}

function choiceOf(preferences: RailPreferences, id: RailItemId): RailChoice {
  if (preferences.shown.includes(id)) return "shown";
  if (preferences.hidden.includes(id)) return "hidden";
  return "default";
}

export function resolveRailItems(
  preferences: RailPreferences,
  context: RailContext,
): ResolvedRailItem[] {
  return orderRailItems(preferences.order).map((id) => {
    const available = isAvailable(id, context);
    const choice = choiceOf(preferences, id);
    const defaultShown = isShownByDefault(id, context);
    const wanted = choice === "default" ? defaultShown : choice === "shown";
    return { id, available, choice, defaultShown, shown: available && wanted };
  });
}

/**
 * Records an explicit choice even when it matches today's default, so a later change in
 * context (a host disconnecting, a provider becoming ready) never hides what the person
 * turned on.
 */
export function setRailItemShown(
  preferences: RailPreferences,
  id: RailItemId,
  shown: boolean,
): RailPreferences {
  const shownIds = preferences.shown.filter((entry) => entry !== id);
  const hiddenIds = preferences.hidden.filter((entry) => entry !== id);
  return shown
    ? { ...preferences, shown: [...shownIds, id], hidden: hiddenIds }
    : { ...preferences, shown: shownIds, hidden: [...hiddenIds, id] };
}

/** Moves an item one step; the full order is stored so later default-order changes keep it. */
export function moveRailItem(
  preferences: RailPreferences,
  id: RailItemId,
  delta: -1 | 1,
): RailPreferences {
  const order = orderRailItems(preferences.order);
  const from = order.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) return preferences;
  const next = [...order];
  [next[from], next[to]] = [next[to]!, next[from]!];
  // Keep ids from other app versions so they return to their place there.
  const foreign = preferences.order.filter((entry) => !isRailItemId(entry));
  return { ...preferences, order: [...next, ...foreign] };
}

/**
 * Saved preferences apply only once client settings have loaded, so items the person hid
 * never flash in first. A failed read falls back to defaults: a rail without its
 * destinations for the whole session is worse than showing an item they hid.
 */
export function railPreferencesForHydration(
  status: "pending" | "ready" | "failed" | "retrying",
  saved: RailPreferences,
): RailPreferences | null {
  if (status === "ready") return saved;
  if (status === "failed") return DEFAULT_RAIL_PREFERENCES;
  return null;
}
