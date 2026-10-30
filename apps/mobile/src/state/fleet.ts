import { createFleetPageAtoms } from "@goat/client-runtime/state/fleet-page";
import { createEnvironmentSummaryAtoms } from "@goat/client-runtime/state/presentation";
import type { EnvironmentId } from "@goat/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { environmentPresentations } from "./presentation";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";
import { environmentThreadShells } from "./threads";

// Only the Fleet tab imports this module, so none of it loads or runs until that tab opens.
const summaries = createEnvironmentSummaryAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  presentationAtom: environmentPresentations.presentationAtom,
});

/** A phone runs no GOAT server, so no machine is "this machine". */
const NO_PRIMARY_ENVIRONMENT = Atom.make<EnvironmentId | null>(null);

export const mobileFleet = createFleetPageAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  connectedEnvironmentIdsAtom: summaries.connectedEnvironmentIdsAtom,
  machineByIdAtom: summaries.machineByIdAtom,
  presentationAtom: environmentPresentations.presentationAtom,
  serverConfigsAtom: environmentServerConfigsAtom,
  primaryEnvironmentIdAtom: NO_PRIMARY_ENVIRONMENT,
  threadShellsAtom: environmentThreadShells.threadShellsAtom,
  remoteLaunches: serverEnvironment.remoteLaunches,
  cloudMachines: serverEnvironment.cloudMachines,
  cloudAgentRuns: serverEnvironment.cloudAgentRuns,
  labelPrefix: "mobile-",
  now: Date.now,
});
