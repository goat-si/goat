import { createFleetPageAtoms } from "@goat/client-runtime/state/fleet-page";
import { createEnvironmentSummaryAtoms } from "@goat/client-runtime/state/presentation";
import { createEnvironmentRpcQueryAtomFamily } from "@goat/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId } from "@goat/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentPresentations } from "./presentation";
import { environmentServerConfigsAtom } from "./server";
import { environmentThreadShells } from "./threads";

// Only the Fleet tab imports this module, so none of it loads or runs until that tab opens.
const summaries = createEnvironmentSummaryAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  presentationAtom: environmentPresentations.presentationAtom,
});

/** A phone runs no GOAT server, so no machine is "this machine". */
const NO_PRIMARY_ENVIRONMENT = Atom.make<EnvironmentId | null>(null);

// Fleet is these queries' only reader on mobile. Without an idle TTL they drop as soon as Fleet
// hides, so a reconnect cannot run them again behind its back.
const fleetQuery = <Tag extends Parameters<typeof createEnvironmentRpcQueryAtomFamily>[1]["tag"]>(
  tag: Tag,
) =>
  createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: `mobile-fleet:${tag}`,
    tag,
    staleTimeMs: 5_000,
    idleTtlMs: 0,
  });

export const mobileFleet = createFleetPageAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  connectedEnvironmentIdsAtom: summaries.connectedEnvironmentIdsAtom,
  machineByIdAtom: summaries.machineByIdAtom,
  presentationAtom: environmentPresentations.presentationAtom,
  serverConfigsAtom: environmentServerConfigsAtom,
  primaryEnvironmentIdAtom: NO_PRIMARY_ENVIRONMENT,
  threadShellsAtom: environmentThreadShells.threadShellsAtom,
  remoteLaunches: fleetQuery(WS_METHODS.remoteLaunchesList),
  cloudMachines: fleetQuery(WS_METHODS.cloudMachinesList),
  cloudAgentRuns: fleetQuery(WS_METHODS.cloudAgentsListRuns),
  labelPrefix: "mobile-",
  now: Date.now,
});
