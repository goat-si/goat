import { useAtomValue } from "@effect/atom-react";
import { createFleetSummaryAtom, type FleetSummary } from "@goat/client-runtime/state/fleet";
import type { FleetCloudAgentGroup } from "@goat/client-runtime/state/fleet-cloud-agents";
import { createFleetPageAtoms, type FleetPageState } from "@goat/client-runtime/state/fleet-page";

import { environmentCatalog } from "../connection/catalog";
import { environmentPresentations, environmentSummaries } from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";
import { environmentThreadShells } from "./threads";

const fleetPage = createFleetPageAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  connectedEnvironmentIdsAtom: environmentSummaries.connectedEnvironmentIdsAtom,
  machineByIdAtom: environmentSummaries.machineByIdAtom,
  presentationAtom: environmentPresentations.presentationAtom,
  serverConfigsAtom: environmentServerConfigsAtom,
  primaryEnvironmentIdAtom,
  threadShellsAtom: environmentThreadShells.threadShellsAtom,
  remoteLaunches: serverEnvironment.remoteLaunches,
  cloudMachines: serverEnvironment.cloudMachines,
  cloudAgentRuns: serverEnvironment.cloudAgentRuns,
  labelPrefix: "",
  now: Date.now,
});

/** Connected environments, for the rail's glance and what dispatchers report. */
export const fleetEnvironmentsAtom = fleetPage.fleetEnvironmentsAtom;

/** Every switched-on environment, so the graph shows hosts that are away or blocked. */
export const fleetPageEnvironmentsAtom = fleetPage.fleetPageEnvironmentsAtom;

export const fleetPageAtom = fleetPage.fleetPageAtom;

const fleetSummaryAtom = createFleetSummaryAtom({
  threadShellsAtom: environmentThreadShells.threadShellsAtom,
  environmentsAtom: fleetEnvironmentsAtom,
  primaryEnvironmentIdAtom,
});

export function useFleetSummary(): FleetSummary {
  return useAtomValue(fleetSummaryAtom);
}

/** Only the Fleet page reads it, so the queries mount, and revalidate, when the page opens. */
export function useFleetCloudAgents(): ReadonlyArray<FleetCloudAgentGroup> {
  return useAtomValue(fleetPage.fleetCloudAgentsAtom);
}

export function useFleetSnapshot(): Omit<FleetPageState, "key"> {
  return useAtomValue(fleetPageAtom);
}
