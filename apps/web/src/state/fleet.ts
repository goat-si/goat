import { useAtomValue } from "@effect/atom-react";
import { connectionRoutes } from "@goat/client-runtime/connection";
import {
  buildFleet,
  createFleetSummaryAtom,
  type FleetEnvironment,
  type FleetRemoteSource,
  type FleetSnapshot,
  type FleetSummary,
} from "@goat/client-runtime/state/fleet";
import {
  type FleetCloudAgentGroup,
  type FleetCloudRunSource,
  groupCloudAgentRuns,
} from "@goat/client-runtime/state/fleet-cloud-agents";
import { resolveProviderInstanceDisplayName } from "@goat/client-runtime/state/provider-instance-display";
import type { CloudMachine, EnvironmentId, RemoteLaunch } from "@goat/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  presentFleetConnection,
  presentFleetMachineConnection,
  UNKNOWN_FLEET_CONNECTION,
  type FleetConnection,
} from "../components/fleet/fleetConnection";
import { environmentCatalog } from "../connection/catalog";
import { environmentPresentations, environmentSummaries } from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";
import { environmentThreadShells } from "./threads";

const EMPTY: ReadonlyArray<never> = Object.freeze([]);

function sameEnvironments(
  left: ReadonlyArray<FleetEnvironment>,
  right: ReadonlyArray<FleetEnvironment>,
): boolean {
  return (
    left.length === right.length &&
    left.every((environment, index) => {
      const other = right[index]!;
      return (
        environment.environmentId === other.environmentId &&
        environment.label === other.label &&
        environment.sshAliases.join("\n") === other.sshAliases.join("\n") &&
        environment.os === other.os &&
        environment.machineKind === other.machineKind &&
        environment.connected === other.connected
      );
    })
  );
}

/** Environments with their labels and the SSH aliases this client uses for them. */
function fleetEnvironments(
  get: Atom.AtomContext,
  includeDisconnected: boolean,
): ReadonlyArray<FleetEnvironment> {
  const catalog = get(environmentCatalog.catalogValueAtom);
  const machineKinds = get(environmentSummaries.machineByIdAtom);
  const connectedIds = get(environmentSummaries.connectedEnvironmentIdsAtom);
  const connected = new Set(connectedIds);
  // A switched-off environment is the user's choice, so the graph leaves it out.
  const ids = includeDisconnected
    ? [...catalog.entries].flatMap(([environmentId, entry]) =>
        entry.enabled || connected.has(environmentId) ? [environmentId] : [],
      )
    : connectedIds;
  const next: FleetEnvironment[] = [];
  for (const environmentId of ids) {
    const entry = catalog.entries.get(environmentId);
    if (entry === undefined) continue;
    const sshAliases: string[] = [];
    for (const route of connectionRoutes(entry)) {
      const profile = Option.getOrNull(route.profile);
      if (profile?._tag === "SshConnectionProfile") sshAliases.push(profile.target.alias);
    }
    const serverConfig = get(
      environmentPresentations.presentationAtom(environmentId),
    )?.serverConfig;
    next.push({
      environmentId,
      label: entry.target.label,
      sshAliases,
      os: serverConfig?.environment.platform.os ?? null,
      machineKind: serverConfig ? (machineKinds.get(environmentId) ?? null) : null,
      connected: connected.has(environmentId),
    });
  }
  const previous = Option.getOrNull(get.self<ReadonlyArray<FleetEnvironment>>());
  return previous !== null && sameEnvironments(previous, next) ? previous : next;
}

/** Connected environments, for the rail's glance and what dispatchers report. */
export const fleetEnvironmentsAtom = Atom.make((get) => fleetEnvironments(get, false)).pipe(
  Atom.withLabel("fleet-environments"),
);

/** Every switched-on environment, so the graph shows hosts that are away or blocked. */
export const fleetPageEnvironmentsAtom = Atom.make((get) => fleetEnvironments(get, true)).pipe(
  Atom.withLabel("fleet-page-environments"),
);

const fleetSummaryAtom = createFleetSummaryAtom({
  threadShellsAtom: environmentThreadShells.threadShellsAtom,
  environmentsAtom: fleetEnvironmentsAtom,
});

export function useFleetSummary(): FleetSummary {
  return useAtomValue(fleetSummaryAtom);
}

/**
 * Only what the graph shows of a connection, so the page rebuilds when a host's
 * state or reason changes, not on every step of a connection attempt.
 */
const fleetConnectionAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): FleetConnection | null => {
    const connection = get(environmentPresentations.presentationAtom(environmentId))?.connection;
    const next = connection === undefined ? null : presentFleetConnection(connection);
    const previous = Option.getOrNull(get.self<FleetConnection | null>());
    return previous !== null &&
      next !== null &&
      previous.state === next.state &&
      previous.label === next.label &&
      previous.reason === next.reason
      ? previous
      : next;
  }).pipe(Atom.withLabel(`fleet-connection:${environmentId}`)),
);

/**
 * What each connected environment last reported about SSH launches and cloud
 * machines. Only the Fleet page reads it, so the queries mount, and revalidate,
 * when the page opens.
 */
const fleetRemoteAtom = Atom.make((get) => {
  const sources: FleetRemoteSource[] = [];
  let loading = false;
  for (const { environmentId } of get(fleetEnvironmentsAtom)) {
    const launches = get(serverEnvironment.remoteLaunches({ environmentId, input: {} }));
    const cloud = get(serverEnvironment.cloudMachines({ environmentId, input: {} }));
    loading ||= AsyncResult.isInitial(launches) || AsyncResult.isInitial(cloud);
    const launchList: ReadonlyArray<RemoteLaunch> =
      Option.getOrNull(AsyncResult.value(launches))?.launches ?? EMPTY;
    const machines: ReadonlyArray<CloudMachine> =
      Option.getOrNull(AsyncResult.value(cloud))?.machines ?? EMPTY;
    if (launchList.length > 0 || machines.length > 0) {
      sources.push({
        dispatcherEnvironmentId: environmentId,
        launches: launchList,
        cloudMachines: machines,
      });
    }
  }
  return { sources, loading };
}).pipe(Atom.withLabel("fleet-remote"));

/**
 * Cloud agent runs each connected environment follows or links. Only the Fleet page reads it,
 * so the queries mount, and revalidate, when the page opens.
 */
const fleetCloudAgentsAtom = Atom.make((get): ReadonlyArray<FleetCloudAgentGroup> => {
  const sources: FleetCloudRunSource[] = [];
  for (const { environmentId, label } of get(fleetEnvironmentsAtom)) {
    const result = get(serverEnvironment.cloudAgentRuns({ environmentId, input: {} }));
    const runs = Option.getOrNull(AsyncResult.value(result))?.runs ?? EMPTY;
    if (runs.length > 0) sources.push({ environmentId, label, runs });
  }
  const next = groupCloudAgentRuns(sources);
  const previous = Option.getOrNull(get.self<ReadonlyArray<FleetCloudAgentGroup>>());
  return previous !== null && JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}).pipe(Atom.withLabel("fleet-cloud-agents"));

export function useFleetCloudAgents(): ReadonlyArray<FleetCloudAgentGroup> {
  return useAtomValue(fleetCloudAgentsAtom);
}

/** What the page draws, so streamed thread updates that change none of it keep one snapshot. */
function snapshotKey(
  snapshot: FleetSnapshot,
  connections: ReadonlyMap<string, FleetConnection>,
  currentMachineId: string | null,
): string {
  return JSON.stringify([
    currentMachineId,
    snapshot.machines.map((machine) => [
      machine.id,
      machine.label,
      machine.subtitle,
      machine.boat,
      machine.os,
      machine.machineKind,
      machine.running,
      machine.attention,
      machine.reported,
      connections.get(machine.id) ?? null,
      machine.agents.map((agent) => [
        agent.key,
        agent.label,
        agent.driver,
        agent.running,
        agent.attention,
        agent.reported,
      ]),
    ]),
    snapshot.threads.map((thread) => [thread.key, thread.title, thread.state, thread.agentKey]),
  ]);
}

interface FleetPageState {
  readonly snapshot: FleetSnapshot;
  /** Each machine's connection from this client, by machine id; absent when unknown. */
  readonly connections: ReadonlyMap<string, FleetConnection>;
  /** The machine this app runs on, as Connections calls it "This machine". */
  readonly currentMachineId: string | null;
  readonly loading: boolean;
  readonly key: string;
}

export const fleetPageAtom = Atom.make((get): FleetPageState => {
  const serverConfigs = get(environmentServerConfigsAtom);
  const remote = get(fleetRemoteAtom);
  const provider = (environmentId: EnvironmentId, instanceId: string) => {
    const provider = serverConfigs
      .get(environmentId)
      ?.providers.find((candidate) => candidate.instanceId === instanceId);
    return provider === undefined
      ? null
      : { label: resolveProviderInstanceDisplayName(provider), driver: provider.driver };
  };
  const primaryEnvironmentId = get(primaryEnvironmentIdAtom);
  const snapshot = buildFleet({
    environments: get(fleetPageEnvironmentsAtom),
    primaryEnvironmentId,
    shells: get(environmentThreadShells.threadShellsAtom),
    remote: remote.sources,
    provider,
  });
  const connections = new Map<string, FleetConnection>();
  let currentMachineId: string | null = null;
  for (const machine of snapshot.machines) {
    if (machine.environmentId === primaryEnvironmentId) currentMachineId = machine.id;
    const live =
      machine.environmentId === null ? null : get(fleetConnectionAtom(machine.environmentId));
    const connection = presentFleetMachineConnection(machine.boat, live);
    if (connection !== UNKNOWN_FLEET_CONNECTION) connections.set(machine.id, connection);
  }
  const key = snapshotKey(snapshot, connections, currentMachineId);
  const previous = Option.getOrNull(get.self<FleetPageState>());
  return previous !== null && previous.key === key && previous.loading === remote.loading
    ? previous
    : { snapshot, connections, currentMachineId, loading: remote.loading, key };
}).pipe(Atom.withLabel("fleet-page"));

export function useFleetSnapshot(): Omit<FleetPageState, "key"> {
  return useAtomValue(fleetPageAtom);
}
