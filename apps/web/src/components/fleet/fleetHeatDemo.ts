import {
  buildFleet,
  type FleetEnvironment,
  type FleetShell,
  type FleetSnapshot,
} from "@goat/client-runtime/state/fleet";
import { fleetMachineHeat, type FleetMachineHeat } from "@goat/client-runtime/state/fleet-heat";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type CloudMachine,
  type CloudMachineAlias,
  type EnvironmentMachineKind,
  type HostStatusEntry,
  type RemoteLaunch,
} from "@goat/contracts";

import {
  presentFleetConnection,
  presentFleetMachineConnection,
  UNKNOWN_FLEET_CONNECTION,
  type FleetConnection,
} from "./fleetConnection";

const GIB = 1024 ** 3;
const SAMPLED_AT = Date.parse("2026-10-20T00:00:00.000Z");
const codex = ProviderInstanceId.make("codex");

function sample(input: {
  readonly cpu: number;
  readonly cores: number;
  readonly load: number;
  readonly memoryUsed: number;
  readonly quota?: number;
  readonly reachable?: boolean;
}): HostStatusEntry {
  const total = 64 * GIB;
  return {
    host: null,
    reachability: input.reachable === false ? "unreachable" : "ok",
    ...(input.reachable === false ? { lastKnown: true as const } : {}),
    metrics: {
      sampledAt: SAMPLED_AT,
      cpuUtilization: input.cpu,
      cpuCount: input.cores,
      availableMemoryBytes: Math.round(total * (1 - input.memoryUsed)),
      totalMemoryBytes: total,
      loadAvg: { oneMinute: input.load, fiveMinutes: input.load, fifteenMinutes: input.load },
      disk: null,
      threads: { running: 0, waiting: 0, queued: 0 },
      quotas:
        input.quota === undefined
          ? []
          : [
              {
                instanceId: codex,
                driver: ProviderDriverKind.make("codex"),
                displayName: "Codex",
                fromCache: false,
                limits: {
                  checkedAt: "2026-10-20T00:00:00.000Z",
                  windows: [
                    { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: input.quota },
                  ],
                },
              },
            ],
    },
  };
}

const MACHINE_KINDS: Readonly<Record<string, EnvironmentMachineKind>> = {
  macmini: "mac-mini",
  "macbookpro-2": "laptop",
  "mac-studio": "mac-studio",
  "lidge-ai": "linux",
  "boat-agent": "cloud",
};

const BOAT_AGENT_ALIAS = "boat-bx_23456789" as CloudMachineAlias;
/** The demo's GOAT server that does not answer, so it is drawn but not counted. */
const UNREACHABLE = "clisu-oracle";
/** A plain SSH host only a dispatcher knows about: drawn and listed, never counted. */
const SSH_ONLY_HOST = "gpu-box";

function reportedLaunch(host: string): RemoteLaunch {
  return {
    host,
    threadId: null,
    title: "Nightly eval",
    launcherThreadId: ThreadId.make("demo-launcher"),
    source: "thread",
    state: "running",
    latest: null,
    hostUnavailableSince: null,
    updatedAt: "2026-10-20T00:00:00.000Z",
  };
}

function boatMachine(alias: CloudMachineAlias, label: string, state: CloudMachine["state"]) {
  return {
    alias,
    sandboxId: alias.slice("boat-".length),
    label,
    provider: "boat",
    type: "default",
    ttlSeconds: 3600,
    presence: "present",
    state,
    deletePending: false,
    lastError: null,
  } as CloudMachine;
}

/** One machine per tier and state, with numbers like a real afternoon on this fleet. */
function demoMachines(): ReadonlyArray<{
  readonly id: string;
  readonly running: number;
  readonly entry: HostStatusEntry | undefined;
}> {
  // Built on call, so production bundles shake the whole fixture away.
  return [
    {
      id: "macmini",
      running: 2,
      entry: sample({ cpu: 0.91, cores: 10, load: 17, memoryUsed: 0.72 }),
    },
    {
      id: "macbookpro-2",
      running: 1,
      entry: sample({ cpu: 0.78, cores: 18, load: 21, memoryUsed: 0.66 }),
    },
    {
      id: "lidge-ai",
      running: 0,
      entry: sample({ cpu: 0.35, cores: 16, load: 4, memoryUsed: 0.4, quota: 82 }),
    },
    {
      id: "mac-studio",
      running: 1,
      entry: sample({ cpu: 0.3, cores: 16, load: 6, memoryUsed: 0.5 }),
    },
    { id: "box", running: 0, entry: sample({ cpu: 0.12, cores: 8, load: 0.4, memoryUsed: 0.3 }) },
    {
      id: "clisu-oracle",
      running: 0,
      entry: sample({ cpu: 0.95, cores: 4, load: 6, memoryUsed: 0.5, reachable: false }),
    },
    {
      id: "boat-agent",
      running: 1,
      entry: sample({ cpu: 0.22, cores: 4, load: 0.8, memoryUsed: 0.35 }),
    },
  ];
}

function runningShell(environmentId: EnvironmentId, id: string): FleetShell {
  const at = "2026-10-20T00:00:00.000Z";
  return {
    environmentId,
    id: ThreadId.make(id),
    title: id,
    providerInstanceId: codex,
    runtime: {
      status: "running",
      activeRunId: null,
      providerInstanceId: codex,
      providerName: null,
      lastError: null,
      updatedAt: at,
    },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingBackgroundTasks: [],
    archivedAt: null,
    deletedAt: null,
    sideChatOf: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    createdAt: at,
    updatedAt: at,
    source: {},
  };
}

/**
 * A fixed fleet with one machine in each heat tier, one with stale metrics, one with none, and
 * two Boat machines (one running and connected, one stopped and only reported), so a burning node
 * and Boat's states can be shown deterministically.
 * It also has a server reached through two routes, a saved server that does not answer, and an
 * SSH host a dispatcher reported, so the count of answering servers can be checked against them.
 * Dev builds draw it at `/fleet?fleetDemo=heat`; the graph's browser test uses it too.
 */
export function fleetHeatDemo(): {
  readonly snapshot: FleetSnapshot;
  readonly heat: ReadonlyMap<string, FleetMachineHeat>;
  readonly currentMachineId: string;
  readonly connections: ReadonlyMap<string, FleetConnection>;
} {
  const MACHINES = demoMachines();
  const environments: FleetEnvironment[] = MACHINES.map(({ id }) => ({
    environmentId: EnvironmentId.make(id),
    label: id,
    sshAliases:
      id === "boat-agent" ? [BOAT_AGENT_ALIAS] : id === "macmini" ? [id, id + ".tailnet"] : [id],
    os: id.startsWith("mac") ? "darwin" : "linux",
    machineKind: MACHINE_KINDS[id] ?? "server",
    connected: id !== UNREACHABLE,
  }));
  const shells = MACHINES.flatMap(({ id, running }) =>
    Array.from({ length: running }, (_, index) =>
      runningShell(EnvironmentId.make(id), id + "-" + index),
    ),
  );
  const snapshot = buildFleet({
    environments,
    primaryEnvironmentId: environments[3]!.environmentId,
    shells,
    remote: [
      {
        dispatcherEnvironmentId: environments[3]!.environmentId,
        launches: [reportedLaunch(SSH_ONLY_HOST)],
        cloudMachines: [
          boatMachine(BOAT_AGENT_ALIAS, "boat-agent", "running"),
          boatMachine("boat-bx_3456789a" as CloudMachineAlias, "nightly-ci", "archived"),
        ],
      },
    ],
    provider: () => ({ label: "Codex", driver: ProviderDriverKind.make("codex") }),
  });
  const entries = new Map(MACHINES.map(({ id, entry }) => [id, entry]));
  const heat = new Map(
    snapshot.machines.map((machine) => [machine.id, fleetMachineHeat(entries.get(machine.label))]),
  );
  const connected = presentFleetConnection({ phase: "connected", error: null, unreachable: false });
  const unreachable = presentFleetConnection({
    phase: "reconnecting",
    error: "Host did not answer",
    unreachable: true,
  });
  const connections = new Map<string, FleetConnection>();
  for (const machine of snapshot.machines) {
    const live =
      machine.label === UNREACHABLE
        ? unreachable
        : machine.label === "boat-agent"
          ? connected
          : null;
    const connection = presentFleetMachineConnection(machine.boat, live);
    if (connection !== UNKNOWN_FLEET_CONNECTION) connections.set(machine.id, connection);
  }
  return { snapshot, heat, currentMachineId: snapshot.machines[3]!.id, connections };
}
