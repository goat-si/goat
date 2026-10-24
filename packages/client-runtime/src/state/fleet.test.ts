import {
  EnvironmentId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type CloudMachine,
  type RemoteLaunch,
} from "@goat/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFleet,
  classifyFleetThread,
  createFleetSummaryAtom,
  summarizeFleet,
  type FleetEnvironment,
  type FleetRemoteSource,
  type FleetShell,
} from "./fleet.ts";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const codex = ProviderInstanceId.make("codex");
const CLOUD_ALIAS = "boat-bx_abcdefgh";

type ShellOptions = {
  readonly status?: NonNullable<FleetShell["runtime"]>["status"] | null;
  readonly background?: boolean;
  readonly approval?: boolean;
  readonly question?: boolean;
  readonly archived?: boolean;
  readonly sideChat?: boolean;
  readonly title?: string;
  readonly launchedBy?: FleetShell["source"]["launchedBy"];
  readonly subagentOf?: string;
  readonly subagentRequest?: FleetShell["pendingSubagentRequest"];
  readonly natives?: ReadonlyArray<
    readonly [id: string, child: string | null, status?: "running" | "waiting"]
  >;
  readonly createdAt?: string;
  readonly updatedAt?: string;
};

function shell(environmentId: EnvironmentId, id: string, options: ShellOptions = {}): FleetShell {
  const status = options.status === undefined ? "running" : options.status;
  return {
    environmentId,
    id: ThreadId.make(id),
    title: options.title ?? id,
    providerInstanceId: codex,
    runtime:
      status === null
        ? null
        : {
            status,
            activeRunId: null,
            providerInstanceId: codex,
            providerName: null,
            lastError: null,
            updatedAt: "2026-10-17T00:00:00.000Z",
          },
    hasPendingApprovals: options.approval ?? false,
    hasPendingUserInput: options.question ?? false,
    pendingBackgroundTasks: options.background
      ? ([{ kind: "command" }] as unknown as FleetShell["pendingBackgroundTasks"])
      : [],
    archivedAt: options.archived ? "2026-10-17T00:00:00.000Z" : null,
    deletedAt: null,
    sideChatOf: options.sideChat ? ThreadId.make("parent") : null,
    lineage:
      options.subagentOf === undefined
        ? { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) }
        : {
            parentThreadId: ThreadId.make(options.subagentOf),
            relationshipToParent: "subagent",
            rootThreadId: ThreadId.make(options.subagentOf),
          },
    pendingSubagentRequest: options.subagentRequest ?? null,
    nativeSubagents: (options.natives ?? []).map(([nativeId, child, status]) => ({
      id: NodeId.make(nativeId),
      childThreadId: child === null ? null : ThreadId.make(child),
      title: "task " + nativeId,
      status: status ?? "running",
    })),
    createdAt: options.createdAt ?? "2026-10-17T00:00:00.000Z",
    updatedAt: options.updatedAt ?? "2026-10-17T00:00:00.000Z",
    source: options.launchedBy === undefined ? {} : { launchedBy: options.launchedBy },
  };
}

function launch(overrides: Partial<RemoteLaunch> & Pick<RemoteLaunch, "host">): RemoteLaunch {
  return {
    threadId: null,
    title: "Remote task",
    launcherThreadId: ThreadId.make("launcher"),
    source: "thread",
    state: "running",
    latest: null,
    hostUnavailableSince: null,
    updatedAt: "2026-10-17T00:00:00.000Z",
    ...overrides,
  };
}

function cloud(overrides: Partial<CloudMachine> = {}): CloudMachine {
  return {
    alias: CLOUD_ALIAS,
    sandboxId: "bx_abcdefgh",
    label: "Cloud box",
    provider: "boat",
    type: "default",
    ttlSeconds: 3600,
    presence: "present",
    state: "running",
    deletePending: false,
    lastError: null,
    ...overrides,
  } as CloudMachine;
}

const env = (environmentId: EnvironmentId, label: string, sshAliases: string[] = []) =>
  ({ environmentId, label, sshAliases }) satisfies FleetEnvironment;

describe("classifyFleetThread", () => {
  it("puts a pending request ahead of active work", () => {
    expect(classifyFleetThread(shell(local, "a", { approval: true }))).toBe("attention");
    expect(classifyFleetThread(shell(local, "b", { question: true, status: "idle" }))).toBe(
      "attention",
    );
  });

  it("counts active runs and idle runs held by background work", () => {
    for (const status of ["preparing", "queued", "starting", "running", "waiting"] as const) {
      expect(classifyFleetThread(shell(local, status, { status }))).toBe("running");
    }
    expect(classifyFleetThread(shell(local, "bg", { status: "idle", background: true }))).toBe(
      "running",
    );
  });

  it("leaves finished, failed, and hidden threads out", () => {
    expect(classifyFleetThread(shell(local, "idle", { status: "idle" }))).toBeNull();
    expect(classifyFleetThread(shell(local, "failed", { status: "failed" }))).toBeNull();
    expect(classifyFleetThread(shell(local, "never", { status: null }))).toBeNull();
    expect(classifyFleetThread(shell(local, "archived", { archived: true }))).toBeNull();
    expect(classifyFleetThread(shell(local, "side", { sideChat: true }))).toBeNull();
  });

  it("leaves subagents out and counts threads an agent launched", () => {
    expect(classifyFleetThread(shell(local, "child", { subagentOf: "parent" }))).toBeNull();
    expect(
      classifyFleetThread(shell(local, "asking", { subagentOf: "parent", approval: true })),
    ).toBeNull();
    expect(
      classifyFleetThread(
        shell(local, "launched", {
          launchedBy: {
            kind: "launch",
            threadId: ThreadId.make("launcher"),
            environmentId: null,
            environmentLabel: null,
            threadTitle: null,
            via: "thread_launch",
          },
        }),
      ),
    ).toBe("running");
  });

  it("puts a parent whose subagent is waiting on the user in attention", () => {
    expect(
      classifyFleetThread(shell(local, "parent", { status: "idle", subagentRequest: "approval" })),
    ).toBe("attention");
  });
});

describe("createFleetSummaryAtom", () => {
  it("counts per connected machine and keeps the same object until a count changes", () => {
    const shellsAtom = Atom.make<ReadonlyArray<FleetShell>>([
      shell(local, "a"),
      shell(local, "b", { question: true }),
      shell(local, "done", { status: "completed" }),
      shell(remote, "c"),
      shell(EnvironmentId.make("disconnected"), "d"),
    ]);
    const environmentsAtom = Atom.make<ReadonlyArray<FleetEnvironment>>([
      env(local, "Mac"),
      env(remote, "Box"),
    ]);
    const summaryAtom = createFleetSummaryAtom({
      threadShellsAtom: shellsAtom,
      environmentsAtom,
    });
    const registry = AtomRegistry.make();
    const stop = registry.subscribe(summaryAtom, () => undefined);
    const first = registry.get(summaryAtom);
    expect(first).toEqual({
      running: 2,
      attention: 1,
      machines: [
        { environmentId: local, label: "Mac", running: 1, attention: 1 },
        { environmentId: remote, label: "Box", running: 1, attention: 0 },
      ],
    });

    registry.set(shellsAtom, [
      shell(local, "a", { title: "Renamed" }),
      shell(local, "b", { question: true }),
      shell(local, "done", { status: "completed" }),
      shell(remote, "c"),
    ]);
    expect(registry.get(summaryAtom)).toBe(first);

    registry.set(shellsAtom, [shell(local, "b", { question: true }), shell(remote, "c")]);
    expect(registry.get(summaryAtom).machines[0]).toMatchObject({ running: 0, attention: 1 });
    stop();
  });
});

describe("buildFleet", () => {
  it("draws a disconnected environment without counting its stale threads", () => {
    const fleet = buildFleet({
      environments: [env(local, "Mac"), { ...env(remote, "Box"), connected: false }],
      primaryEnvironmentId: local,
      shells: [shell(local, "a"), shell(remote, "stale", { question: true })],
      remote: [],
    });
    expect(
      fleet.machines.map((machine) => [machine.label, machine.running, machine.attention]),
    ).toEqual([
      ["Mac", 1, 0],
      ["Box", 0, 0],
    ]);
    expect(fleet.threads.map((thread) => thread.title)).toEqual(["a"]);
  });

  it("counts the GOAT servers that answer, as the rail does, whatever else it draws", () => {
    const unreachable = EnvironmentId.make("unreachable");
    const environments: FleetEnvironment[] = [
      env(local, "Mac", ["mac", "mac.tailnet"]),
      env(remote, "Box", ["box"]),
      { ...env(unreachable, "Away", ["away"]), connected: false },
    ];
    const fleet = buildFleet({
      environments,
      primaryEnvironmentId: local,
      shells: [shell(local, "a"), shell(remote, "b")],
      remote: [
        {
          dispatcherEnvironmentId: local,
          // Two routes to one server, a plain SSH host, and a stopped Boat machine.
          launches: [launch({ host: "mac.tailnet" }), launch({ host: "devbox" })],
          cloudMachines: [cloud({ state: "archived", label: "Nightly" })],
        },
      ],
    });
    expect(fleet.machines.map((machine) => [machine.label, machine.answering])).toEqual([
      ["Mac", true],
      ["Box", true],
      ["Away", false],
      ["Nightly", false],
      ["devbox", false],
    ]);
    expect(fleet.totals.machines).toBe(2);
    const summary = summarizeFleet(
      [shell(local, "a"), shell(remote, "b")],
      environments.filter((environment) => environment.connected !== false),
    );
    expect(summary.machines).toHaveLength(fleet.totals.machines);
  });

  it("lists only top-level threads, with a subagent's request on its parent", () => {
    const fleet = buildFleet({
      environments: [env(local, "Mac")],
      primaryEnvironmentId: local,
      shells: [
        shell(local, "parent", { subagentRequest: "user_input" }),
        shell(local, "child", { subagentOf: "parent", question: true }),
        shell(local, "grandchild", { subagentOf: "child" }),
      ],
      remote: [],
    });
    expect(fleet.totals).toMatchObject({ running: 0, attention: 1 });
    expect(fleet.threads.map((thread) => [thread.title, thread.state])).toEqual([
      ["parent", "attention"],
    ]);
  });

  it("groups native subagents, nested and under delegated children, on their top-level row", () => {
    const fleet = buildFleet({
      environments: [env(local, "Mac")],
      primaryEnvironmentId: local,
      shells: [
        shell(local, "parent", {
          natives: [
            ["n1", "native-a"],
            ["n2", null, "waiting"],
          ],
        }),
        // Native child threads have no runs; a nested record lives on the spawning child.
        shell(local, "native-a", {
          subagentOf: "parent",
          status: null,
          title: "/root/reader",
          natives: [["n3", "native-b"]],
        }),
        shell(local, "delegated", { subagentOf: "parent", natives: [["n4", null]] }),
        shell(local, "other"),
      ],
      remote: [],
    });
    expect(fleet.threads.map((thread) => thread.title)).toEqual(["other", "parent"]);
    expect(fleet.totals).toMatchObject({ running: 2, attention: 0 });
    const [other, parent] = fleet.threads;
    expect(
      parent!.subagents.map((subagent) => [
        subagent.title,
        subagent.status,
        subagent.ref?.threadId ?? null,
      ]),
    ).toEqual([
      ["/root/reader", "running", "native-a"],
      ["task n2", "waiting", null],
      ["task n3", "running", "native-b"],
      ["task n4", "running", null],
    ]);
    expect(other!.subagents).toEqual([]);
  });

  it("counts a launch whose thread is loaded here once, as that live thread", () => {
    const remoteThread = shell(remote, "t1", {
      status: "completed",
      launchedBy: { environmentId: local, threadId: ThreadId.make("launcher") },
    } as ShellOptions);
    const fleet = buildFleet({
      environments: [env(local, "Mac"), env(remote, "Box")],
      primaryEnvironmentId: local,
      shells: [remoteThread],
      remote: [
        {
          dispatcherEnvironmentId: local,
          launches: [launch({ host: "box", threadId: ThreadId.make("t1") })],
          cloudMachines: [],
        },
      ],
    });
    expect(fleet.totals).toEqual({ running: 0, attention: 0, reported: 0, machines: 2 });
    expect(fleet.threads).toEqual([]);
  });

  it("reports an unresolved running launch on its SSH host, without a link", () => {
    const fleet = buildFleet({
      environments: [env(local, "Mac")],
      primaryEnvironmentId: local,
      shells: [],
      remote: [
        {
          dispatcherEnvironmentId: local,
          launches: [
            launch({ host: "devbox", title: "Fix tests" }),
            launch({ host: "devbox", state: "settled" }),
            launch({ host: "gone", hostUnavailableSince: "2026-10-17T00:00:00.000Z" }),
          ],
          cloudMachines: [],
        },
      ],
    });
    // The SSH host is drawn with its reported work, but only the GOAT server counts as a machine.
    expect(fleet.totals).toEqual({ running: 0, attention: 0, reported: 1, machines: 1 });
    expect(fleet.machines[1]).toMatchObject({
      kind: "ssh",
      label: "devbox",
      subtitle: "via Mac",
      answering: false,
    });
    expect(fleet.threads).toMatchObject([{ title: "Fix tests", ref: null, reportedBy: "Mac" }]);
  });

  it("ignores disconnected shells when resolving a launch", () => {
    const fleet = buildFleet({
      environments: [env(local, "Mac")],
      primaryEnvironmentId: local,
      shells: [shell(remote, "t1", { status: "completed" })],
      remote: [
        {
          dispatcherEnvironmentId: local,
          launches: [launch({ host: "box", threadId: ThreadId.make("t1") })],
          cloudMachines: [],
        },
      ],
    });
    expect(fleet.totals.reported).toBe(1);
  });

  it("shows a connected cloud machine once when a launch resolved its host", () => {
    const fleet = buildFleet({
      environments: [env(local, "Mac"), env(remote, "Box")],
      primaryEnvironmentId: null,
      shells: [shell(remote, "t1")],
      remote: [
        {
          dispatcherEnvironmentId: local,
          launches: [launch({ host: CLOUD_ALIAS, threadId: ThreadId.make("t1") })],
          cloudMachines: [cloud()],
        },
      ],
    });
    expect(fleet.machines).toHaveLength(2);
    expect(fleet.machines[1]).toMatchObject({
      kind: "environment",
      subtitle: "Cloud box",
      boat: { status: "running", source: "record" },
      running: 1,
    });
  });

  it("matches a cloud alias to the primary's SSH connection and adds no work for its state", () => {
    const fleet = buildFleet({
      environments: [env(local, "Mac"), env(remote, "Box", [CLOUD_ALIAS])],
      primaryEnvironmentId: local,
      shells: [],
      remote: [{ dispatcherEnvironmentId: local, launches: [], cloudMachines: [cloud()] }],
    });
    expect(fleet.machines).toHaveLength(2);
    expect(fleet.machines[1]).toMatchObject({
      environmentId: remote,
      boat: { status: "running", source: "record" },
    });
    expect(fleet.totals).toMatchObject({ running: 0, attention: 0, reported: 0 });
  });

  it("keeps a cloud machine separate when nothing ties it to a connection", () => {
    const fleet = buildFleet({
      environments: [env(local, "Mac"), env(remote, "Box", [CLOUD_ALIAS])],
      primaryEnvironmentId: remote,
      shells: [],
      remote: [
        {
          dispatcherEnvironmentId: local,
          launches: [],
          cloudMachines: [
            cloud(),
            cloud({ alias: "boat-bx_zzzzzzzz" as CloudMachine["alias"], deletePending: true }),
          ],
        },
      ],
    });
    expect(fleet.machines.map((machine) => machine.kind)).toEqual([
      "environment",
      "environment",
      "cloud",
    ]);
    expect(fleet.machines[2]).toMatchObject({ label: "Cloud box", subtitle: "via Mac" });
  });

  it("names a reported cloud machine's Boat state, so a stopped one is not mistaken for away", () => {
    const fleet = buildFleet({
      environments: [env(local, "Mac")],
      primaryEnvironmentId: local,
      shells: [],
      remote: [
        {
          dispatcherEnvironmentId: local,
          launches: [],
          cloudMachines: [
            cloud({ state: "archived" }),
            cloud({ alias: "boat-bx_zzzzzzzz" as CloudMachine["alias"], state: "provisioning" }),
          ],
        },
      ],
    });
    expect(fleet.machines.slice(1).map((machine) => [machine.kind, machine.boat])).toEqual([
      ["cloud", { status: "stopped", source: "record" }],
      ["cloud", { status: "starting", source: "record" }],
    ]);
    expect(fleet.machines[0]!.boat).toBeNull();
  });

  it("falls back to the reserved alias only when no record describes the host", () => {
    const fleet = buildFleet({
      environments: [env(local, "Mac"), env(remote, "Box", ["BOAT-bx_23456789"])],
      primaryEnvironmentId: local,
      shells: [],
      remote: [
        {
          dispatcherEnvironmentId: local,
          launches: [launch({ host: CLOUD_ALIAS }), launch({ host: "devbox" })],
          // The dispatcher's cloud machine list has not loaded.
          cloudMachines: [],
        },
      ],
    });
    const byLabel = new Map(fleet.machines.map((machine) => [machine.label, machine]));
    expect(byLabel.get(CLOUD_ALIAS)).toMatchObject({
      kind: "cloud",
      boat: { status: "unknown", source: "alias" },
      reported: 1,
    });
    expect(byLabel.get("Box")).toMatchObject({
      kind: "environment",
      boat: { status: "unknown", source: "alias" },
    });
    expect(byLabel.get("devbox")).toMatchObject({ kind: "ssh", boat: null });
  });

  it("keeps a connected machine's Boat identity while Boat deletes it", () => {
    const fleet = buildFleet({
      environments: [env(local, "Mac"), env(remote, "Box", [CLOUD_ALIAS])],
      primaryEnvironmentId: local,
      shells: [],
      remote: [
        {
          dispatcherEnvironmentId: local,
          launches: [],
          cloudMachines: [cloud({ deletePending: true })],
        },
      ],
    });
    expect(fleet.machines).toHaveLength(2);
    expect(fleet.machines[1]!.boat).toEqual({ status: "deleting", source: "record" });
  });

  it("groups agents per machine", () => {
    const fleet = buildFleet({
      environments: [env(local, "Mac")],
      primaryEnvironmentId: local,
      shells: [shell(local, "a"), shell(local, "b", { approval: true }), shell(local, "c")],
      remote: [],
      provider: () => ({ label: "Codex", driver: ProviderDriverKind.make("codex") }),
    });
    expect(fleet.machines[0]!.agents).toEqual([
      { key: "codex", label: "Codex", driver: "codex", running: 2, attention: 1, reported: 0 },
    ]);
  });
});

describe("buildFleet thread order", () => {
  const at = (minute: number) => `2026-10-17T00:${String(minute).padStart(2, "0")}:00.000Z`;
  const titles = (shells: ReadonlyArray<FleetShell>) =>
    buildFleet({
      environments: [env(local, "Mac")],
      primaryEnvironmentId: local,
      shells,
      remote: [],
    }).threads.map((thread) => thread.title);

  const first = shell(local, "first", { createdAt: at(1) });
  const second = shell(local, "second", { createdAt: at(2) });
  const third = shell(local, "third", { createdAt: at(3) });

  it("lists threads oldest first, whatever order the shells arrive in", () => {
    expect(titles([third, first, second])).toEqual(["first", "second", "third"]);
  });

  it("keeps rows in place when activity and status change", () => {
    expect(
      titles([
        shell(local, "first", { createdAt: at(1), updatedAt: at(59) }),
        shell(local, "second", { createdAt: at(2), approval: true, updatedAt: at(58) }),
        shell(local, "third", { createdAt: at(3), status: "idle", background: true }),
      ]),
    ).toEqual(["first", "second", "third"]);
  });

  it("appends a newly started thread at the end", () => {
    expect(titles([first, second, third, shell(local, "new", { createdAt: at(9) })])).toEqual([
      "first",
      "second",
      "third",
      "new",
    ]);
  });

  it("drops a finished thread, keeps one waiting on the user, and restores a re-run in place", () => {
    const settled = [
      shell(local, "first", { createdAt: at(1), status: "completed" }),
      shell(local, "second", { createdAt: at(2), status: "idle", question: true }),
      shell(local, "third", { createdAt: at(3), status: "interrupted" }),
    ];
    expect(titles(settled)).toEqual(["second"]);
    expect(
      titles([
        ...settled.slice(1),
        shell(local, "first", { createdAt: at(1), status: "queued", updatedAt: at(30) }),
      ]),
    ).toEqual(["first", "second"]);
  });

  it("breaks a creation-time tie by thread, and lists reported work after live threads", () => {
    const fleet = buildFleet({
      environments: [env(local, "Mac", ["devbox"])],
      primaryEnvironmentId: local,
      shells: [shell(remote, "zeta"), shell(local, "beta"), shell(local, "alpha")],
      remote: [
        {
          dispatcherEnvironmentId: local,
          launches: [launch({ host: "devbox", title: "Reported" })],
          cloudMachines: [],
        },
      ],
    });
    expect(fleet.threads.map((thread) => thread.title)).toEqual(["alpha", "beta", "Reported"]);
  });
});

describe("buildFleet machine identity", () => {
  // The MacBook's desktop server and the headless server SSH launches keep beside it, plus two
  // hosts the desktop connects to by its own aliases while the headless server dispatches work to
  // them under other aliases. After a restart the hosts are still connecting.
  const mac = EnvironmentId.make("desktop");
  const headless = EnvironmentId.make("headless");
  const mini = EnvironmentId.make("mini-env");
  const lidge = EnvironmentId.make("lidge-env");
  const provider = () => ({ label: "Codex", driver: ProviderDriverKind.make("codex") });
  const environments: FleetEnvironment[] = [
    { ...env(mac, "jun's MacBook Pro"), machineId: "machine-mbp", machineUserId: "jun" },
    { ...env(headless, "Headless server"), machineId: "machine-mbp", machineUserId: "jun" },
    { ...env(mini, "MINI", ["mini"]), machineId: "machine-mini", connected: false },
    { ...env(lidge, "lidge-AI-AI", ["lidge"]), machineId: "machine-lidge", connected: false },
  ];
  const dispatchedAt = "2026-10-24T09:32:00.000Z";
  const headlessReports: FleetRemoteSource = {
    dispatcherEnvironmentId: headless,
    launches: [
      launch({ host: "mini", threadId: ThreadId.make("ws9"), updatedAt: dispatchedAt }),
      launch({ host: "lidge-ts", threadId: ThreadId.make("ws10"), updatedAt: dispatchedAt }),
    ],
    cloudMachines: [],
  };

  it("draws the desktop's server and its headless server as one machine with both servers' threads", () => {
    const fleet = buildFleet({
      environments: environments.slice(0, 2),
      primaryEnvironmentId: mac,
      shells: [shell(mac, "here"), ...["h1", "h2", "h3", "h4"].map((id) => shell(headless, id))],
      remote: [],
      provider,
    });
    expect(fleet.machines.map((machine) => [machine.label, machine.environmentId])).toEqual([
      ["jun's MacBook Pro", mac],
    ]);
    expect(fleet.machines[0]).toMatchObject({ running: 5, answering: true });
    expect(fleet.machines[0]!.agents).toEqual([
      { key: "codex", label: "Codex", driver: "codex", running: 5, attention: 0, reported: 0 },
    ]);
    expect(fleet.totals.machines).toBe(1);
    expect(fleet.threads.find((thread) => thread.title === "h1")?.ref).toEqual({
      environmentId: headless,
      threadId: ThreadId.make("h1"),
    });
    const summary = summarizeFleet(
      [shell(mac, "here"), shell(headless, "h1")],
      environments.slice(0, 2),
      mac,
    );
    expect(summary.machines).toEqual([
      { environmentId: mac, label: "jun's MacBook Pro", running: 2, attention: 0 },
    ]);
  });

  it("puts a host a same-machine server dispatched to on the connection that reaches it", () => {
    const fleet = buildFleet({
      environments,
      primaryEnvironmentId: mac,
      // The desktop saw both remote threads before it restarted, so their shells are cached.
      shells: [
        shell(mini, "ws9", { title: "GCU WS9", updatedAt: "2026-10-24T09:00:00.000Z" }),
        shell(lidge, "ws10", { title: "GCU WS10", updatedAt: "2026-10-24T09:00:00.000Z" }),
      ],
      remote: [headlessReports],
      provider,
    });
    expect(fleet.machines.map((machine) => machine.label)).toEqual([
      "jun's MacBook Pro",
      "MINI",
      "lidge-AI-AI",
    ]);
    expect(fleet.machines.map((machine) => [machine.label, machine.reported])).toEqual([
      ["jun's MacBook Pro", 0],
      ["MINI", 1],
      ["lidge-AI-AI", 1],
    ]);
    // The cached shells name the agent, so no reported work stands in as an unknown one.
    expect(fleet.machines.flatMap((machine) => machine.agents.map((agent) => agent.label))).toEqual(
      ["Codex", "Codex"],
    );
    expect(fleet.threads.map((thread) => [thread.title, thread.ref, thread.state])).toEqual([
      ["GCU WS9", null, "reported"],
      ["GCU WS10", null, "reported"],
    ]);
  });

  it("keeps reported work a cached shell shows finished, since only the dispatcher can tell", () => {
    const fleet = buildFleet({
      environments,
      primaryEnvironmentId: mac,
      shells: [
        // Stamped by lidge's clock after the dispatcher's last word, yet a resumed run is newer.
        shell(lidge, "ws10", { status: "completed", updatedAt: "2026-10-24T09:40:00.000Z" }),
      ],
      remote: [headlessReports],
      provider,
    });
    expect(fleet.machines.map((machine) => [machine.label, machine.reported])).toEqual([
      ["jun's MacBook Pro", 0],
      ["MINI", 1],
      ["lidge-AI-AI", 1],
    ]);
    expect(fleet.machines[2]!.reportedAliases).toEqual([{ via: headless, alias: "lidge-ts" }]);
  });

  it("reads another OS account's aliases as its own, even on the same machine", () => {
    const fleet = buildFleet({
      environments: [
        environments[0]!,
        { ...environments[1]!, machineUserId: "someone-else" },
        ...environments.slice(2),
      ],
      primaryEnvironmentId: mac,
      shells: [],
      remote: [headlessReports],
    });
    expect(fleet.machines.map((machine) => [machine.label, machine.subtitle])).toEqual([
      ["jun's MacBook Pro", null],
      ["MINI", null],
      ["lidge-AI-AI", null],
      ["mini", "via jun's MacBook Pro"],
      ["lidge-ts", "via jun's MacBook Pro"],
    ]);
  });

  it("puts an alias one server resolved on that machine for every server reading its SSH config", () => {
    const fleet = buildFleet({
      environments,
      primaryEnvironmentId: mac,
      shells: [shell(lidge, "ws10", { title: "GCU WS10" })],
      remote: [
        // The desktop's own report names lidge-ts with work this client has never loaded.
        {
          dispatcherEnvironmentId: mac,
          launches: [launch({ host: "lidge-ts", title: "Other work" })],
          cloudMachines: [],
        },
        headlessReports,
      ],
      provider,
    });
    expect(fleet.machines.map((machine) => [machine.label, machine.reported])).toEqual([
      ["jun's MacBook Pro", 0],
      ["MINI", 1],
      ["lidge-AI-AI", 2],
    ]);
    expect(fleet.machines[2]!.reportedAliases).toEqual([
      { via: mac, alias: "lidge-ts" },
      { via: headless, alias: "lidge-ts" },
    ]);
  });

  it("counts one agent across a machine's servers only when both name the same provider", () => {
    const work = ProviderInstanceId.make("work");
    const providers = new Map([
      [mac, { label: "Codex", driver: ProviderDriverKind.make("codex") }],
      [headless, { label: "Claude", driver: ProviderDriverKind.make("claudeAgent") }],
    ]);
    const fleet = buildFleet({
      environments: environments.slice(0, 2),
      primaryEnvironmentId: mac,
      shells: [
        { ...shell(mac, "a"), providerInstanceId: work },
        { ...shell(headless, "b"), providerInstanceId: work },
      ],
      remote: [],
      provider: (environmentId) => providers.get(environmentId) ?? null,
    });
    expect(fleet.machines[0]!.agents.map((agent) => [agent.key, agent.label])).toEqual([
      ["work", "Codex"],
      [JSON.stringify([headless, "work"]), "Claude"],
    ]);
    expect(fleet.threads.map((thread) => thread.agentKey)).toEqual([
      "work",
      JSON.stringify([headless, "work"]),
    ]);
  });

  it("keeps hosts apart when servers report different machines", () => {
    const fleet = buildFleet({
      environments: [
        { ...env(mac, "Mac"), machineId: "machine-a" },
        { ...env(headless, "Other"), machineId: "machine-b" },
        { ...env(remote, "Old server") },
      ],
      primaryEnvironmentId: mac,
      shells: [],
      remote: [],
    });
    expect(fleet.machines.map((machine) => machine.label)).toEqual(["Mac", "Other", "Old server"]);
  });
});
