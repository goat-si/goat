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
import { findRemoteShell, presentRemoteLaunches } from "./remoteLaunches.ts";

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
  | "nativeSubagents"
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
   * The server's physical machine. GOAT servers that report the same one, such as the desktop's
   * own server and the headless server SSH launches keep beside it, are one Fleet machine.
   * Absent on servers that predate it.
   */
  readonly machineId?: string | null;
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

/**
 * The environment that stands for each environment's machine. Environments that report one
 * machine share it: the primary when it is among them, else the first connected one, else the
 * first listed. Every other environment stands for itself.
 */
export function fleetMachineOwners(
  environments: ReadonlyArray<Pick<FleetEnvironment, "environmentId" | "machineId" | "connected">>,
  primaryEnvironmentId: EnvironmentId | null,
): ReadonlyMap<EnvironmentId, EnvironmentId> {
  const groups = new Map<string, Array<(typeof environments)[number]>>();
  for (const environment of environments) {
    if (!environment.machineId) continue;
    const group = groups.get(environment.machineId) ?? [];
    group.push(environment);
    groups.set(environment.machineId, group);
  }
  const owners = new Map(
    environments.map((environment) => [environment.environmentId, environment.environmentId]),
  );
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const rank = (environment: (typeof group)[number]) =>
      environment.environmentId === primaryEnvironmentId
        ? 0
        : environment.connected !== false
          ? 1
          : 2;
    const owner = group.reduce((best, candidate) =>
      rank(candidate) < rank(best) ? candidate : best,
    );
    for (const environment of group) owners.set(environment.environmentId, owner.environmentId);
  }
  return owners;
}

/** @public Tested directly; createFleetSummaryAtom is its only runtime caller. */
export function summarizeFleet(
  shells: ReadonlyArray<FleetShell>,
  environments: ReadonlyArray<
    Pick<FleetEnvironment, "environmentId" | "label" | "machineId" | "connected">
  >,
  primaryEnvironmentId: EnvironmentId | null = null,
): FleetSummary {
  const owners = fleetMachineOwners(environments, primaryEnvironmentId);
  const listed = environments.filter(
    (environment) => owners.get(environment.environmentId) === environment.environmentId,
  );
  const counts = new Map<EnvironmentId, { running: number; attention: number }>(
    listed.map((environment) => [environment.environmentId, { running: 0, attention: 0 }]),
  );
  let running = 0;
  let attention = 0;
  for (const shell of shells) {
    const owner = owners.get(shell.environmentId);
    const machine = owner === undefined ? undefined : counts.get(owner);
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
    machines: listed.map((environment) => ({
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
  readonly primaryEnvironmentIdAtom?: Atom.Atom<EnvironmentId | null>;
}): Atom.Atom<FleetSummary> {
  return Atom.make((get) => {
    const next = summarizeFleet(
      get(input.threadShellsAtom),
      get(input.environmentsAtom),
      input.primaryEnvironmentIdAtom === undefined ? null : get(input.primaryEnvironmentIdAtom),
    );
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
  /**
   * A GOAT server this client is connected to. Only these count as Fleet machines, as on the
   * rail: a saved server that does not answer, or an SSH or cloud host a dispatcher reported,
   * is drawn and listed but not counted.
   */
  readonly answering: boolean;
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
  /**
   * Provider-native subagents working for this thread, nested ones included. They share its
   * session, so they are part of its row rather than rows of their own.
   */
  readonly subagents: ReadonlyArray<FleetSubagent>;
}

export interface FleetSubagent {
  readonly key: string;
  /** Null until the provider reports the subagent's own thread. */
  readonly ref: ScopedThreadRef | null;
  readonly title: string;
  readonly status: "pending" | "running" | "waiting";
}

export interface FleetSnapshot {
  readonly machines: ReadonlyArray<FleetMachine>;
  readonly threads: ReadonlyArray<FleetThread>;
  readonly totals: {
    readonly running: number;
    readonly attention: number;
    readonly reported: number;
    /** Answering GOAT servers, the same number the rail counts. */
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
  const owners = fleetMachineOwners(input.environments, input.primaryEnvironmentId);
  const aliasesOf = new Map<EnvironmentId, string[]>();
  for (const environment of input.environments) {
    const owner = owners.get(environment.environmentId) ?? environment.environmentId;
    const ownerEnvironment =
      input.environments.find((env) => env.environmentId === owner) ?? environment;
    const existing = machines.get(machineId(owner));
    if (existing === undefined) {
      machines.set(machineId(owner), {
        id: machineId(owner),
        label: ownerEnvironment.label,
        subtitle: null,
        kind: "environment",
        os: ownerEnvironment.os ?? environment.os ?? null,
        machineKind: ownerEnvironment.machineKind ?? environment.machineKind ?? null,
        environmentId: owner,
        sshHost: null,
        boat: null,
        answering: environment.connected !== false,
        running: 0,
        attention: 0,
        reported: 0,
        agents: new Map(),
      });
    } else {
      existing.answering ||= environment.connected !== false;
      existing.os ??= environment.os ?? null;
      existing.machineKind ??= environment.machineKind ?? null;
    }
    aliasesOf.set(owner, [...(aliasesOf.get(owner) ?? []), ...environment.sshAliases]);
    for (const alias of environment.sshAliases)
      environmentBySshAlias.set(alias, environment.environmentId);
  }
  const nodeOf = (environmentId: EnvironmentId) =>
    machines.get(machineId(owners.get(environmentId) ?? environmentId));
  const connectedIds = new Set(
    input.environments
      .filter((environment) => environment.connected !== false)
      .map((environment) => environment.environmentId),
  );
  const connectedShells = input.shells.filter((shell) => connectedIds.has(shell.environmentId));
  // A known server that is not connected yet still has the shells this client cached from it:
  // too stale to count, but they say which machine runs a reported thread and with which agent.
  const cachedShells = input.shells.filter(
    (shell) => owners.has(shell.environmentId) && !connectedIds.has(shell.environmentId),
  );
  const subagentsByThread = gatherNativeSubagents(connectedShells);

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
  const agentOf = (
    shell: Pick<FleetShell, "environmentId" | "providerInstanceId">,
  ): Pick<FleetAgent, "key" | "label" | "driver"> => {
    const provider = input.provider?.(shell.environmentId, shell.providerInstanceId) ?? null;
    return {
      key: shell.providerInstanceId,
      label: provider?.label ?? shell.providerInstanceId,
      driver: provider?.driver ?? null,
    };
  };

  for (const shell of connectedShells) {
    const state = classifyFleetThread(shell);
    if (state === null) continue;
    const machine = nodeOf(shell.environmentId);
    if (machine === undefined) continue;
    const agent = agentOf(shell);
    count(machine, agent, state);
    threads.push({
      key: JSON.stringify([shell.environmentId, shell.id]),
      machineId: machine.id,
      ref: scopeThreadRef(shell.environmentId, shell.id),
      title: shell.title,
      agentKey: agent.key,
      agentLabel: agent.label,
      agentDriver: agent.driver,
      state,
      createdAt: shell.createdAt,
      reportedBy: null,
      subagents: subagentsByThread.get(shellKey(shell)) ?? [],
    });
  }

  for (const source of input.remote) {
    const dispatcher = source.dispatcherEnvironmentId;
    const dispatcherLabel = labelOf.get(dispatcher) ?? null;
    const dispatcherOwner = owners.get(dispatcher) ?? dispatcher;
    // Servers on the client's own machine read the same SSH config, so its aliases name its hosts.
    const sharesClientAliases =
      input.primaryEnvironmentId !== null &&
      dispatcherOwner === (owners.get(input.primaryEnvironmentId) ?? input.primaryEnvironmentId);
    // Shells from disconnected environments must not resolve a launch: their
    // state is stale, so the launch would vanish from both live and reported.
    const groups = presentRemoteLaunches({
      dispatcherEnvironmentId: dispatcher,
      launches: source.launches,
      shells: connectedShells,
    });
    const cachedShellOf = (launch: RemoteLaunch) =>
      launch.threadId === null ? null : findRemoteShell(cachedShells, dispatcher, launch.threadId);
    const resolvedHosts = new Map<string, EnvironmentId>();
    for (const group of groups) {
      if (group.environmentId !== null) resolvedHosts.set(group.host, group.environmentId);
    }
    for (const launch of source.launches) {
      const cached = cachedShellOf(launch);
      if (cached !== null && !resolvedHosts.has(launch.host))
        resolvedHosts.set(launch.host, cached.environmentId);
    }
    const resolveAlias = (alias: string) =>
      resolvedHosts.get(alias) ??
      (sharesClientAliases ? environmentBySshAlias.get(alias) : undefined);
    const hostMachine = (alias: string, kind: "ssh" | "cloud", label: string) => {
      const environmentId = resolveAlias(alias);
      const node = environmentId === undefined ? undefined : nodeOf(environmentId);
      if (node !== undefined) return node;
      // One alias reached from one machine is one host, whichever server there dispatched to it.
      const id = JSON.stringify(["ssh", dispatcherOwner, alias]);
      const existing = machines.get(id);
      if (existing !== undefined) return existing;
      const viaLabel = labelOf.get(dispatcherOwner) ?? dispatcherLabel;
      const created: MutableMachine = {
        id,
        label,
        subtitle: viaLabel === null ? null : "via " + viaLabel,
        kind,
        os: null,
        machineKind: null,
        environmentId: null,
        sshHost: { via: dispatcher, alias },
        boat: null,
        answering: false,
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
          const node = nodeOf(environmentId);
          if (node !== undefined) node.boat = identifyBoatMachine({ record: cloud, aliases: [] });
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
        const cached = cachedShellOf(launch);
        // A cached shell that finished after the dispatcher last heard from the run is newer news.
        if (
          cached !== null &&
          classifyFleetThread(cached) === null &&
          Date.parse(cached.updatedAt) > Date.parse(launch.updatedAt)
        )
          return;
        const agent =
          cached === null
            ? { key: UNKNOWN_AGENT, label: UNKNOWN_AGENT_LABEL, driver: null }
            : agentOf(cached);
        const machine = hostMachine(group.host, "ssh", group.host);
        count(machine, agent, "reported");
        threads.push({
          key: JSON.stringify(["reported", dispatcher, group.host, index]),
          machineId: machine.id,
          ref: null,
          // Dispatch records carry no title; the latest report says what the work is.
          title: cached?.title ?? presented.title ?? launch.latest?.summary ?? "Untitled launch",
          agentKey: agent.key,
          agentLabel: agent.label,
          agentDriver: agent.driver,
          state: "reported",
          createdAt: null,
          reportedBy: dispatcherLabel,
          subagents: [],
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
      machines: list.filter((machine) => machine.answering).length,
    },
  };
}

function machineId(environmentId: EnvironmentId): string {
  return JSON.stringify(["env", environmentId]);
}

function shellKey(shell: Pick<FleetShell, "environmentId" | "id">): string {
  return JSON.stringify([shell.environmentId, shell.id]);
}

/**
 * Each thread's live native subagents, attached to its top-level ancestor: a nested Codex v2
 * subagent is recorded on the subagent that spawned it, and a delegated child is not a Fleet row.
 */
function gatherNativeSubagents(
  shells: ReadonlyArray<FleetShell>,
): ReadonlyMap<string, ReadonlyArray<FleetSubagent>> {
  const byKey = new Map(shells.map((shell) => [shellKey(shell), shell]));
  const gathered = new Map<string, FleetSubagent[]>();
  for (const shell of shells) {
    const natives = shell.nativeSubagents ?? [];
    if (natives.length === 0 || shell.archivedAt !== null || shell.deletedAt !== null) continue;
    let root = shell;
    const seen = new Set([shellKey(root)]);
    while (root.lineage.relationshipToParent === "subagent" && root.lineage.parentThreadId) {
      const parentKey = shellKey({
        environmentId: root.environmentId,
        id: root.lineage.parentThreadId,
      });
      const parent = byKey.get(parentKey);
      if (parent === undefined || seen.has(parentKey)) break;
      seen.add(parentKey);
      root = parent;
    }
    const list = gathered.get(shellKey(root)) ?? [];
    for (const native of natives) {
      const child =
        native.childThreadId === null
          ? undefined
          : byKey.get(shellKey({ environmentId: shell.environmentId, id: native.childThreadId }));
      list.push({
        key: JSON.stringify([shell.environmentId, native.id]),
        ref:
          native.childThreadId === null
            ? null
            : scopeThreadRef(shell.environmentId, native.childThreadId),
        title: child?.title || native.title || "Subagent",
        status: native.status,
      });
    }
    gathered.set(shellKey(root), list);
  }
  return gathered;
}
