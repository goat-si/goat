export type UsageTab = "fleet" | "usage" | "limits";

const TWO_TABS = [
  { value: "usage", label: "Usage" },
  { value: "limits", label: "Limits" },
] as const satisfies readonly { value: UsageTab; label: string }[];

const THREE_TABS = [{ value: "fleet", label: "Fleet" }, ...TWO_TABS] as const satisfies readonly {
  value: UsageTab;
  label: string;
}[];

export interface FleetTabEnvironment {
  /** Switched on in Connections, or connected anyway. */
  readonly enabled: boolean;
  readonly connected: boolean;
  /** The server says it is a hub. */
  readonly hubEnabled: boolean;
}

/**
 * Fleet answers "what runs on my machines", so it shows once this phone reaches more than one
 * GOAT server (a hub's devices count, since each is an environment of its own) or is connected
 * to a hub, whose devices the Fleet tab then explains how to open.
 */
export function showsFleetTab(environments: Iterable<FleetTabEnvironment>): boolean {
  let reached = 0;
  for (const environment of environments) {
    if (environment.connected && environment.hubEnabled) return true;
    if (environment.enabled || environment.connected) reached += 1;
  }
  return reached > 1;
}

export function usageTabOptions(fleetVisible: boolean) {
  return fleetVisible ? THREE_TABS : TWO_TABS;
}

/**
 * The segment shown: the person's pick on this screen, else the link's tab, else Fleet when it
 * shows and Limits when it does not. Fleet falls back to Limits while it is hidden.
 */
export function resolveUsageTab(input: {
  readonly choice: UsageTab | null;
  readonly param: string | undefined;
  readonly fleetVisible: boolean;
}): UsageTab {
  const wanted =
    input.choice ??
    (input.param === "usage" || input.param === "limits" || input.param === "fleet"
      ? input.param
      : null);
  if (wanted === "usage" || wanted === "limits") return wanted;
  if (wanted === "fleet") return input.fleetVisible ? "fleet" : "limits";
  return input.fleetVisible ? "fleet" : "limits";
}
