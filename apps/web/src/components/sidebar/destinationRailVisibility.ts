import { createContext, useContext } from "react";

import { useClientSettings, useClientSettingsHydrationStatus } from "../../hooks/useSettings";
import { railPreferencesForHydration, railShowsBot } from "./destinationRail.logic";

/** True while the desktop destination rail is on screen; the sidebar footer drops its duplicates. */
export const DestinationRailVisibleContext = createContext(false);

export function useDestinationRailVisible(): boolean {
  return useContext(DestinationRailVisibleContext);
}

/** Whether the rail on screen switches to GOAT Bot, so the sidebar needs no Bots and Threads tabs. */
export function useDestinationRailShowsBot(): boolean {
  const visible = useDestinationRailVisible();
  const hydration = useClientSettingsHydrationStatus();
  const saved = useClientSettings((settings) => settings.destinationRail);
  return visible && railShowsBot(railPreferencesForHydration(hydration, saved));
}
