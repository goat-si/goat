import type {
  CloudMachine,
  EnvironmentId,
  EnvironmentMachineKind,
  ExecutionEnvironmentPlatformOs,
  OrchestrationV2ThreadShell,
  ProviderDriverKind,
  RemoteLaunch,
  ScopedThreadRef,
} from "@goat/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { identifyBoatMachine, type BoatMachineIdentity } from "../cloudMachines.ts";
import { scopeThreadRef } from "../environment/scoped.ts";
import { threadRuntimeIsActive, type EnvironmentThreadShell } from "./models.ts";
import { presentRemoteLaunches } from "./remoteLaunches.ts";

/**
 * Fleet: what is running right now across every connected environment, for the
 * destination rail's glance and the /fleet page.
 *
 * Counts come only from live thread shells. Remote launches and cloud machines
 * are what a dispatching server last reported; they are read while the page is
 * open and never feed the rail, which would otherwise keep a stale count.
 */

/** "attention" is a pending approval or question: the thread needs the user. */
export type FleetThreadState = "running" | "attention";

export type FleetShell = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "title"
  | "providerInstanceId"
  | "runtime"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingBackgroundTasks"
  | "archivedAt"
  | "deletedAt"
  | "sideChatOf"
  | "lineage"
  | "createdAt"
  | "updatedAt"
> & { readonly source: Pick<OrchestrationV2ThreadShell, "launchedBy"> };

/**
 * Whether a thread is in the Fleet now; null means it has finished or never
 * counts. A thread stays while its run is active (preparing, queued, starting,
 * running, waiting), while it waits on the user (a pending approval, question,
 * or a subagent's request), and while background work holds an idle run open.
 * It leaves once nothing holds it: completed, failed, interrupted, or idle.
 * A new run brings it back.
 *
 * Only top-level threads count. Subagents (delegate_task children and
 * provider-native subagents) are their parent's work, so a parent waiting on a
 * subagent's request needs the user. Threads started with goat_thread_launch or
 * create_threads have no subagent lineage and count on their own. Side chats,
 * archived and deleted threads do not count. A run parked at idle while its
 * background work holds completion still counts as running, as in the sidebar.
 */
export function classifyFleetThread(
  shell: Pick<
    FleetShell,
    | "runtime"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "pendingBackgroundTasks"
    | "archivedAt"
    | "deletedAt"
    | "sideChatOf"
    | "lineage"
  >,
): FleetThreadState | null {
  if (
    shell.archivedAt !== null ||
    shell.deletedAt !== null ||
    shell.sideChatOf != null ||
    shell.lineage.relationshipToParent === "subagent"
  ) {
    return null;
  }
  if (
    shell.hasPendingApprovals ||
    shell.hasPendingUserInput ||
    shell.pendingSubagentRequest != null
  )
    return "attention";
  if (threadRuntimeIsActive(shell.runtime)) return "running";
  if (shell.runtime?.status === "idle" && shell.pendingBackgroundTasks.length > 0) {
    return "running";
  }
  return null;
}

export interface FleetEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** SSH aliases this client reaches the environment through. */
  readonly sshAliases: ReadonlyArray<string>;
  /** What the server reports about its host; absent until its config loads. */
  readonly os?: ExecutionEnvironmentPlatformOs | null;
  readonly machineKind?: EnvironmentMachineKind | null;
  /**
   * False draws the machine without counting its threads: a disconnected
   * environment's shells are stale. Absent means connected.
   */
  readonly connected?: boolean;
}

export interface FleetMachineSummary {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly running: number;
  readonly attention: number;
}

export interface FleetSummary {
  readonly running: number;
  readonly attention: number;
  /** Every connected environment, in connection order, busy or not. */
  readonly machines: ReadonlyArray<FleetMachineSummary>;
}

function summarizeFleet(
  shells: ReadonlyArray<FleetShell>,
  environments: ReadonlyArray<Pick<FleetEnvironment, "environmentId" | "label">>,
): FleetSummary {
  const counts = new Map<EnvironmentId, { running: number; attention: number }>(
    environments.map((environment) => [environment.environmentId, { running: 0, attention: 0 }]),
  );
  let running = 0;
  let attention = 0;
  for (const shell of shells) {
    const machine = counts.get(shell.environmentId);
    if (machine === undefined) continue;
    const state = classifyFleetThread(shell);
    if (state === null) continue;
    machine[state] += 1;
    if (state === "running") running += 1;
    else attention += 1;
  }
  return {
    running,
    attention,
    machines: environments.map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
      ...counts.get(environment.environmentId)!,
    })),
  };
}

function fleetSummariesEqual(left: FleetSummary, right: FleetSummary): boolean {
  return (
    left.running === right.running &&
    left.attention === right.attention &&
    left.machines.length === right.machines.length &&
    left.machines.every((machine, index) => {
      const other = right.machines[index]!;
      return (
        machine.environmentId === other.environmentId &&
        machine.label === other.label &&
        machine.running === other.running &&
        machine.attention === other.attention
      );
    })
  );
}

/** The rail's glance. Keeps the previous object while counts and labels hold, so
    the rail item renders only when what it shows changes. */
export function createFleetSummaryAtom(input: {
  readonly threadShellsAtom: Atom.Atom<ReadonlyArray<FleetShell>>;
  readonly environmentsAtom: Atom.Atom<ReadonlyArray<FleetEnvironment>>;
}): Atom.Atom<FleetSummary> {
  return Atom.make((get) => {
    const next = summarizeFleet(get(input.threadShellsAtom), get(input.environmentsAtom));
    const previous = Option.getOrNull(get.self<FleetSummary>());
    return previous !== null && fleetSummariesEqual(previous, next) ? previous : next;
  }).pipe(Atom.withLabel("fleet-summary"));
}

export type FleetMachineKind = "environment" | "ssh" | "cloud";

export interface FleetAgent {
  /** Provider instance id, or "unknown" for work a dispatcher reported. */
  readonly key: string;
  readonly label: string;
  /** The provider's driver, for its logo; null when unknown. */
  readonly driver: ProviderDriverKind | null;
  readonly running: number;
  readonly attention: number;
  readonly reported: number;
}

export interface FleetMachine {
  readonly id: string;
  readonly label: string;
  readonly subtitle: string | null;
  readonly kind: FleetMachineKind;
  /** Host OS and hardware shape, known for connected environments only. */
  readonly os: ExecutionEnvironmentPlatformOs | null;
  readonly machineKind: EnvironmentMachineKind | null;
  readonly environmentId: EnvironmentId | null;
  /** An SSH or cloud host a dispatcher reported, by the alias that dispatcher reaches it through. */
  readonly sshHost: { readonly via: EnvironmentId; readonly alias: string } | null;
  /** Set when the host is a Boat machine, from a server's record or else its reserved alias. */
  readonly boat: BoatMachineIdentity | null;
  readonly running: number;
  readonly attention: number;
  readonly reported: number;
  readonly agents: ReadonlyArray<FleetAgent>;
}

export interface FleetThread {
  readonly key: string;
  readonly machineId: string;
  /** Null for reported work this client cannot open. */
  readonly ref: ScopedThreadRef | null;
  readonly title: string;
  readonly agentKey: string;
  readonly agentLabel: string;
  readonly agentDriver: ProviderDriverKind | null;
  readonly state: FleetThreadState | "reported";
  /** When the thread was created; null for reported work, which has no start time. */
  readonly createdAt: string | null;
  /** The dispatching environment's label, for reported work. */
  readonly reportedBy: string | null;
}

export interface FleetSnapshot {
  readonly machines: ReadonlyArray<FleetMachine>;
  readonly threads: ReadonlyArray<FleetThread>;
  readonly totals: {
    readonly running: number;
    readonly attention: number;
    readonly reported: number;
    readonly machines: number;
  };
}

export interface FleetRemoteSource {
  readonly dispatcherEnvironmentId: EnvironmentId;
  readonly launches: ReadonlyArray<RemoteLaunch>;
  readonly cloudMachines: ReadonlyArray<CloudMachine>;
}

const UNKNOWN_AGENT = "unknown";
const UNKNOWN_AGENT_LABEL = "Unknown agent";

/**
 * Oldest first, so a new thread joins at the end and a status change or a
 * streamed update never moves a row. Reported work has no start time and
 * follows in the order its dispatcher listed it.
 */
function compareFleetThreads(left: FleetThread, right: FleetThread): number {
  if (left.createdAt === null || right.createdAt === null) {
    return (left.createdAt === null ? 1 : 0) - (right.createdAt === null ? 1 : 0);
  }
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

type MutableAgent = { -readonly [K in keyof FleetAgent]: FleetAgent[K] };
type MutableMachine = Omit<{ -readonly [K in keyof FleetMachine]: FleetMachine[K] }, "agents"> & {
  agents: Map<string, MutableAgent>;
};

/** The /fleet page's full picture: live threads plus what dispatchers reported. */
export function buildFleet(input: {
  readonly environments: ReadonlyArray<FleetEnvironment>;
  /** Desktop reaches cloud machines through the primary environment's SSH aliases. */
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly shells: ReadonlyArray<FleetShell>;
  readonly remote: ReadonlyArray<FleetRemoteSource>;
  /** A provider instance's display name and driver in the environment that runs it. */
  readonly provider?: (
    environmentId: EnvironmentId,
    instanceId: string,
  ) => { readonly label: string; readonly driver: ProviderDriverKind } | null;
}): FleetSnapshot {
  const machines = new Map<string, MutableMachine>();
  const threads: FleetThread[] = [];
  const labelOf = new Map(input.environments.map((env) => [env.environmentId, env.label]));
  const environmentBySshAlias = new Map<string, EnvironmentId>();
  const aliasesOf = new Map(input.environments.map((env) => [env.environmentId, env.sshAliases]));
  for (const environment of input.environments) {
    machines.set(machineId(environment.environmentId), {
      id: machineId(environment.environmentId),
      label: environment.label,
      subtitle: null,
      kind: "environment",
      os: environment.os ?? null,
      machineKind: environment.machineKind ?? null,
      environmentId: environment.environmentId,
      sshHost: null,
      boat: null,
      running: 0,
      attention: 0,
      reported: 0,
      agents: new Map(),
    });
    for (const alias of environment.sshAliases)
      environmentBySshAlias.set(alias, environment.environmentId);
  }
  const connectedIds = new Set(
    input.environments
      .filter((environment) => environment.connected !== false)
      .map((environment) => environment.environmentId),
  );
  const connectedShells = input.shells.filter((shell) => connectedIds.has(shell.environmentId));

  const count = (
    machine: MutableMachine,
    agentIdentity: Pick<FleetAgent, "key" | "label" | "driver">,
    state: FleetThread["state"],
  ) => {
    machine[state] += 1;
    const agent = machine.agents.get(agentIdentity.key) ?? {
      ...agentIdentity,
      running: 0,
      attention: 0,
      reported: 0,
    };
    agent[state] += 1;
    machine.agents.set(agentIdentity.key, agent);
  };

  for (const shell of connectedShells) {
    const state = classifyFleetThread(shell);
    if (state === null) continue;
    const machine = machines.get(machineId(shell.environmentId))!;
    const provider = input.provider?.(shell.environmentId, shell.providerInstanceId) ?? null;
    const agentLabel = provider?.label ?? shell.providerInstanceId;
    const agentDriver = provider?.driver ?? null;
    count(
      machine,
      { key: shell.providerInstanceId, label: agentLabel, driver: agentDriver },
      state,
    );
    threads.push({
      key: JSON.stringify([shell.environmentId, shell.id]),
      machineId: machine.id,
      ref: scopeThreadRef(shell.environmentId, shell.id),
      title: shell.title,
      agentKey: shell.providerInstanceId,
      agentLabel,
      agentDriver,
      state,
      createdAt: shell.createdAt,
      reportedBy: null,
    });
  }

  for (const source of input.remote) {
    const dispatcher = source.dispatcherEnvironmentId;
    const dispatcherLabel = labelOf.get(dispatcher) ?? null;
    // Shells from disconnected environments must not resolve a launch: their
    // state is stale, so the launch would vanish from both live and reported.
    const groups = presentRemoteLaunches({
      dispatcherEnvironmentId: dispatcher,
      launches: source.launches,
      shells: connectedShells,
    });
    const resolvedHosts = new Map<string, EnvironmentId>();
    for (const group of groups) {
      if (group.environmentId !== null) resolvedHosts.set(group.host, group.environmentId);
    }
    const resolveAlias = (alias: string) =>
      resolvedHosts.get(alias) ??
      (dispatcher === input.primaryEnvironmentId ? environmentBySshAlias.get(alias) : undefined);
    const hostMachine = (alias: string, kind: "ssh" | "cloud", label: string) => {
      const environmentId = resolveAlias(alias);
      if (environmentId !== undefined) return machines.get(machineId(environmentId))!;
      const id = JSON.stringify(["ssh", dispatcher, alias]);
      const existing = machines.get(id);
      if (existing !== undefined) return existing;
      const created: MutableMachine = {
        id,
        label,
        subtitle: dispatcherLabel === null ? null : "via " + dispatcherLabel,
        kind,
        os: null,
        machineKind: null,
        environmentId: null,
        sshHost: { via: dispatcher, alias },
        boat: null,
        running: 0,
        attention: 0,
        reported: 0,
        agents: new Map(),
      };
      machines.set(id, created);
      return created;
    };

    for (const cloud of source.cloudMachines) {
      if (cloud.deletePending || cloud.presence === "not_found") {
        // No node for a machine on its way out, but a connected one still says why it is going.
        const environmentId = resolveAlias(cloud.alias);
        if (environmentId !== undefined) {
          machines.get(machineId(environmentId))!.boat = identifyBoatMachine({
            record: cloud,
            aliases: [],
          });
        }
        continue;
      }
      const machine = hostMachine(cloud.alias, "cloud", cloud.label);
      machine.boat = identifyBoatMachine({ record: cloud, aliases: [] });
      if (machine.kind === "environment" && machine.label !== cloud.label) {
        machine.subtitle = cloud.label;
      }
    }

    groups.forEach((group) => {
      group.launches.forEach((presented, index) => {
        const launch = presented.launch;
        // A launch whose thread is loaded here is that live thread, idle or not.
        if (presented.ref !== null) return;
        if (launch.state !== "launching" && launch.state !== "running") return;
        if (launch.hostUnavailableSince !== null) return;
        const machine = hostMachine(group.host, "ssh", group.host);
        count(
          machine,
          { key: UNKNOWN_AGENT, label: UNKNOWN_AGENT_LABEL, driver: null },
          "reported",
        );
        threads.push({
          key: JSON.stringify(["reported", dispatcher, group.host, index]),
          machineId: machine.id,
          ref: null,
          // Dispatch records carry no title; the latest report says what the work is.
          title: presented.title ?? launch.latest?.summary ?? "Untitled launch",
          agentKey: UNKNOWN_AGENT,
          agentLabel: UNKNOWN_AGENT_LABEL,
          agentDriver: null,
          state: "reported",
          createdAt: null,
          reportedBy: dispatcherLabel,
        });
      });
    });
  }

  for (const machine of machines.values()) {
    if (machine.boat !== null) continue;
    const aliases =
      machine.environmentId !== null
        ? (aliasesOf.get(machine.environmentId) ?? [])
        : machine.sshHost !== null
          ? [machine.sshHost.alias]
          : [];
    machine.boat = identifyBoatMachine({ record: null, aliases });
    if (machine.boat !== null && machine.kind === "ssh") machine.kind = "cloud";
  }

  threads.sort(compareFleetThreads);
  const list = [...machines.values()].map(({ agents, ...machine }): FleetMachine => ({
    ...machine,
    agents: [...agents.values()],
  }));
  return {
    machines: list,
    threads,
    totals: {
      running: list.reduce((sum, machine) => sum + machine.running, 0),
      attention: list.reduce((sum, machine) => sum + machine.attention, 0),
      reported: list.reduce((sum, machine) => sum + machine.reported, 0),
      machines: list.length,
    },
  };
}

function machineId(environmentId: EnvironmentId): string {
  return JSON.stringify(["env", environmentId]);
}
