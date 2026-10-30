import type {
  CloudMachine,
  EnvironmentId,
  EnvironmentMachineKind,
  RemoteLaunch,
  ServerConfig,
} from "@goat/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  connectionProgressLabel,
  type EnvironmentPresentation,
} from "../connection/presentation.ts";
import { connectionRoutes } from "../connection/routes.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import {
  buildFleet,
  type FleetEnvironment,
  type FleetRemoteSource,
  type FleetShell,
  type FleetSnapshot,
} from "./fleet.ts";
import {
  groupCloudAgentRuns,
  type FleetCloudAgentGroup,
  type FleetCloudRunSource,
} from "./fleetCloudAgents.ts";
import {
  isFleetConnectionWait,
  presentFleetConnection,
  presentFleetMachineConnection,
  UNKNOWN_FLEET_CONNECTION,
  type FleetConnection,
} from "./fleetConnection.ts";
import { resolveProviderInstanceDisplayName } from "./providerInstanceDisplay.ts";

const EMPTY: ReadonlyArray<never> = Object.freeze([]);

type QueryTarget = { readonly environmentId: EnvironmentId; readonly input: {} };
type Query<A> = (target: QueryTarget) => Atom.Atom<AsyncResult.AsyncResult<A, unknown>>;

export interface FleetPageState {
  readonly snapshot: FleetSnapshot;
  /** Each machine's connection from this client, by machine id; absent when unknown. */
  readonly connections: ReadonlyMap<string, FleetConnection>;
  /** The machine this app runs on, as Connections calls it "This machine". */
  readonly currentMachineId: string | null;
  readonly loading: boolean;
  readonly key: string;
}

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
        environment.machineId === other.machineId &&
        environment.machineUserId === other.machineUserId &&
        environment.connected === other.connected
      );
    })
  );
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
      machine.reportedAliases,
      machine.answering,
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
    snapshot.threads.map((thread) => [
      thread.key,
      thread.title,
      thread.state,
      thread.agentKey,
      thread.subagents.map((subagent) => [subagent.key, subagent.title, subagent.status]),
    ]),
  ]);
}

/**
 * The Fleet page's atoms, shared by web and mobile so both count the same threads on the same
 * machines. The remote launch, cloud machine and cloud agent queries mount only while a reader
 * of the page or cloud agent atoms does.
 */
export function createFleetPageAtoms(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly connectedEnvironmentIdsAtom: Atom.Atom<ReadonlyArray<EnvironmentId>>;
  readonly machineByIdAtom: Atom.Atom<ReadonlyMap<EnvironmentId, EnvironmentMachineKind>>;
  readonly presentationAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<EnvironmentPresentation | null>;
  readonly serverConfigsAtom: Atom.Atom<ReadonlyMap<EnvironmentId, ServerConfig>>;
  readonly primaryEnvironmentIdAtom: Atom.Atom<EnvironmentId | null>;
  readonly threadShellsAtom: Atom.Atom<ReadonlyArray<FleetShell>>;
  readonly remoteLaunches: Query<{ readonly launches: ReadonlyArray<RemoteLaunch> }>;
  readonly cloudMachines: Query<{ readonly machines: ReadonlyArray<CloudMachine> }>;
  readonly cloudAgentRuns: Query<{ readonly runs: FleetCloudRunSource["runs"] }>;
  readonly labelPrefix: string;
  /** Epoch ms, for when a connection entered its state. */
  readonly now: () => number;
}) {
  /** Environments with their labels and the SSH aliases this client uses for them. */
  const fleetEnvironments = (
    get: Atom.AtomContext,
    includeDisconnected: boolean,
  ): ReadonlyArray<FleetEnvironment> => {
    const catalog = get(input.catalogValueAtom);
    const machineKinds = get(input.machineByIdAtom);
    const connectedIds = get(input.connectedEnvironmentIdsAtom);
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
      const serverConfig = get(input.presentationAtom(environmentId))?.serverConfig;
      next.push({
        environmentId,
        label: entry.target.label,
        sshAliases,
        os: serverConfig?.environment.platform.os ?? null,
        machineKind: serverConfig ? (machineKinds.get(environmentId) ?? null) : null,
        machineId: serverConfig?.environment.machineId ?? null,
        machineUserId: serverConfig?.environment.machineUserId ?? null,
        connected: connected.has(environmentId),
      });
    }
    const previous = Option.getOrNull(get.self<ReadonlyArray<FleetEnvironment>>());
    return previous !== null && sameEnvironments(previous, next) ? previous : next;
  };

  /** Connected environments, for the rail's glance and what dispatchers report. */
  const fleetEnvironmentsAtom = Atom.make((get) => fleetEnvironments(get, false)).pipe(
    Atom.withLabel(`${input.labelPrefix}fleet-environments`),
  );

  /** Every switched-on environment, so the graph shows hosts that are away or blocked. */
  const fleetPageEnvironmentsAtom = Atom.make((get) => fleetEnvironments(get, true)).pipe(
    Atom.withLabel(`${input.labelPrefix}fleet-page-environments`),
  );

  /**
   * Only what the page shows of a connection, so it rebuilds when a host's state, reason or
   * named step changes, not on every retry countdown tick. It keeps when the state began, so a
   * wait can say how long it has lasted.
   */
  const fleetConnectionAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): FleetConnection | null => {
      const connection = get(input.presentationAtom(environmentId))?.connection;
      const presented = connection === undefined ? null : presentFleetConnection(connection);
      const previous = Option.getOrNull(get.self<FleetConnection | null>());
      const step =
        presented === null || connection === undefined || !isFleetConnectionWait(presented.state)
          ? null
          : connection.retryAt != null
            ? "Waiting to retry"
            : connectionProgressLabel({ ...connection, retryAt: null }, 0);
      const next =
        presented === null
          ? null
          : {
              ...presented,
              step,
              since:
                previous !== null &&
                previous.state === presented.state &&
                previous.since !== undefined
                  ? previous.since
                  : input.now(),
            };
      return previous !== null &&
        next !== null &&
        previous.state === next.state &&
        previous.label === next.label &&
        previous.reason === next.reason &&
        previous.step === next.step
        ? previous
        : next;
    }).pipe(Atom.withLabel(`${input.labelPrefix}fleet-connection:${environmentId}`)),
  );

  /** What each connected environment last reported about SSH launches and cloud machines. */
  const fleetRemoteAtom = Atom.make((get) => {
    const sources: FleetRemoteSource[] = [];
    let loading = false;
    for (const { environmentId } of get(fleetEnvironmentsAtom)) {
      const launches = get(input.remoteLaunches({ environmentId, input: {} }));
      const cloud = get(input.cloudMachines({ environmentId, input: {} }));
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
  }).pipe(Atom.withLabel(`${input.labelPrefix}fleet-remote`));

  /** Cloud agent runs each connected environment follows or links. */
  const fleetCloudAgentsAtom = Atom.make((get): ReadonlyArray<FleetCloudAgentGroup> => {
    const sources: FleetCloudRunSource[] = [];
    for (const { environmentId, label } of get(fleetEnvironmentsAtom)) {
      const result = get(input.cloudAgentRuns({ environmentId, input: {} }));
      const runs = Option.getOrNull(AsyncResult.value(result))?.runs ?? EMPTY;
      if (runs.length > 0) sources.push({ environmentId, label, runs });
    }
    const next = groupCloudAgentRuns(sources);
    const previous = Option.getOrNull(get.self<ReadonlyArray<FleetCloudAgentGroup>>());
    return previous !== null && JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
  }).pipe(Atom.withLabel(`${input.labelPrefix}fleet-cloud-agents`));

  const fleetPageAtom = Atom.make((get): FleetPageState => {
    const serverConfigs = get(input.serverConfigsAtom);
    const remote = get(fleetRemoteAtom);
    const provider = (environmentId: EnvironmentId, instanceId: string) => {
      const provider = serverConfigs
        .get(environmentId)
        ?.providers.find((candidate) => candidate.instanceId === instanceId);
      return provider === undefined
        ? null
        : { label: resolveProviderInstanceDisplayName(provider), driver: provider.driver };
    };
    const primaryEnvironmentId = get(input.primaryEnvironmentIdAtom);
    const snapshot = buildFleet({
      environments: get(fleetPageEnvironmentsAtom),
      primaryEnvironmentId,
      shells: get(input.threadShellsAtom),
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
  }).pipe(Atom.withLabel(`${input.labelPrefix}fleet-page`));

  return {
    fleetEnvironmentsAtom,
    fleetPageEnvironmentsAtom,
    fleetCloudAgentsAtom,
    fleetPageAtom,
  };
}
