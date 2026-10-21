import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  fleetHostStatusNeeded,
  fleetMachineHeat,
  fleetMachineHeatEqual,
  matchFleetHostEntries,
  type FleetMachineHeat,
} from "@goat/client-runtime/state/fleet-heat";
import type { EnvironmentId, HostStatusEntry } from "@goat/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext } from "react";

import { useLiveRefresh } from "../hooks/useLiveRefresh";
import { fleetEnvironmentsAtom, fleetPageAtom, fleetPageEnvironmentsAtom } from "./fleet";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { HOST_STATUS_REFRESH_MS, hostStatusAtom, refreshHostStatus } from "./hostStatus";

/** A failed refresh keeps its last answer; show it as last known, never as live. */
const asLastKnown = (hosts: ReadonlyArray<HostStatusEntry>): ReadonlyArray<HostStatusEntry> =>
  hosts.map((entry) =>
    entry.metrics === undefined
      ? { ...entry, reachability: "unreachable" }
      : { ...entry, reachability: "unreachable", lastKnown: true },
  );

/** One host-status read Fleet holds open, for refreshing and for its failure state. */
export interface FleetHostStatusSource {
  readonly environmentId: EnvironmentId;
  readonly atom: ReturnType<typeof hostStatusAtom>;
}

/**
 * Each connected environment's host-status answer, by environment. The primary
 * answers for every SSH host it holds open, and for itself from a separate local
 * read, so this machine's row never waits on a slow remote. See
 * fleetHostStatusNeeded for when another environment is read, since each read
 * samples CPU. Another environment fans out to its own SSH hosts only when a
 * Fleet machine is one it dispatched to; otherwise it reads itself alone. Sources
 * lists every read, answered or not, for refreshing. Mounting this starts the reads.
 */
export const fleetHostReportsAtom = Atom.make((get) => {
  const environments = get(fleetEnvironmentsAtom);
  const primary = get(primaryEnvironmentIdAtom);
  const reports = new Map<EnvironmentId, ReadonlyArray<HostStatusEntry>>();
  const sources: FleetHostStatusSource[] = [];
  /** Null while the first answer is on its way. */
  const read = (
    environmentId: EnvironmentId,
    options?: { readonly local: boolean },
  ): ReadonlyArray<HostStatusEntry> | null => {
    const atom = hostStatusAtom(environmentId, options);
    sources.push({ environmentId, atom });
    const result = get(atom);
    const hosts = Option.getOrNull(AsyncResult.value(result))?.hosts ?? null;
    if (hosts === null) return AsyncResult.isFailure(result) ? [] : null;
    return AsyncResult.isFailure(result) ? asLastKnown(hosts) : hosts;
  };
  const hasPrimary = environments.some((environment) => environment.environmentId === primary);
  let primaryHosts: ReadonlyArray<HostStatusEntry> | null = [];
  if (hasPrimary && primary !== null) {
    const own = read(primary, { local: true });
    const fanOut = read(primary);
    primaryHosts = fanOut?.filter((entry) => entry.host !== null) ?? null;
    const self =
      own?.find((entry) => entry.host === null) ?? fanOut?.find((entry) => entry.host === null);
    if (self !== undefined || primaryHosts !== null)
      reports.set(primary, [...(self === undefined ? [] : [self]), ...(primaryHosts ?? [])]);
  }
  const dispatchers = new Set(
    get(fleetPageAtom).snapshot.machines.flatMap((machine) =>
      machine.sshHost === null ? [] : [machine.sshHost.via],
    ),
  );
  for (const environment of environments) {
    if (environment.environmentId === primary) continue;
    const needed = fleetHostStatusNeeded({
      environmentId: environment.environmentId,
      sshAliases: environment.sshAliases,
      primaryEnvironmentId: primary,
      primaryHosts,
      dispatchers,
    });
    if (!needed) continue;
    const hosts = read(environment.environmentId, {
      local: !dispatchers.has(environment.environmentId),
    });
    if (hosts !== null) reports.set(environment.environmentId, hosts);
  }
  return { reports, sources } as const;
}).pipe(Atom.withLabel("fleet-host-reports"));

/**
 * Each Fleet machine's heat by machine id. A tier change keeps its previous
 * value for hysteresis, and an unchanged picture keeps the previous map so the
 * graph does not re-render on an idle poll.
 */
const fleetHeatAtom = Atom.make((get): ReadonlyMap<string, FleetMachineHeat> => {
  const { snapshot } = get(fleetPageAtom);
  const entries = matchFleetHostEntries({
    machines: snapshot.machines,
    sshAliases: new Map(
      get(fleetPageEnvironmentsAtom).map((environment) => [
        environment.environmentId,
        environment.sshAliases,
      ]),
    ),
    reports: get(fleetHostReportsAtom).reports,
    primaryEnvironmentId: get(primaryEnvironmentIdAtom),
  });
  const previous = Option.getOrNull(get.self<ReadonlyMap<string, FleetMachineHeat>>());
  const next = new Map<string, FleetMachineHeat>();
  let changed = previous === null || previous.size !== snapshot.machines.length;
  for (const machine of snapshot.machines) {
    const before = previous?.get(machine.id);
    const heat = fleetMachineHeat(entries.get(machine.id), before?.tier);
    const kept = before !== undefined && fleetMachineHeatEqual(before, heat) ? before : heat;
    changed ||= kept !== before;
    next.set(machine.id, kept);
  }
  return changed || previous === null ? next : previous;
}).pipe(Atom.withLabel("fleet-heat"));

/**
 * How hard each Fleet machine is working, by machine id, from the same
 * host-status reads Settings shows. Reads start when a component mounts this and
 * stop when the last one unmounts; they refresh every 15s only while the
 * document is visible and someone has interacted recently.
 */
export function useFleetHostMetrics(): ReadonlyMap<string, FleetMachineHeat> {
  const registry = useContext(RegistryContext);
  const heat = useAtomValue(fleetHeatAtom);
  useLiveRefresh(
    () => {
      for (const source of registry.get(fleetHostReportsAtom).sources) {
        refreshHostStatus(registry, source.atom);
      }
    },
    { key: "fleet-host-status", intervalMs: HOST_STATUS_REFRESH_MS },
  );
  return heat;
}
