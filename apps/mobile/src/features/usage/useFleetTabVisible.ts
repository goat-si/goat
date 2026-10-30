import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { environmentPresentations } from "../../state/presentation";
import { showsFleetTab } from "./usageTabs";

const fleetTabVisibleAtom = Atom.make((get) =>
  showsFleetTab(
    [...get(environmentPresentations.presentationsAtom).values()].map((presentation) => ({
      enabled: presentation.entry.enabled,
      connected: presentation.connection.phase === "connected",
      hubEnabled: presentation.serverConfig?.settings.hub.enabled === true,
    })),
  ),
).pipe(Atom.withLabel("mobile-usage-fleet-tab-visible"));

export function useFleetTabVisible(): boolean {
  return useAtomValue(fleetTabVisibleAtom);
}
