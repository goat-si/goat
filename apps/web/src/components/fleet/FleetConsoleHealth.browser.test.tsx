import { RegistryProvider } from "@effect/atom-react";
import { EnvironmentId, type HostStatusEntry, type HostStorageHealth } from "@goat/contracts";
import type { AsyncResult as AsyncResultType, Atom as AtomType } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import type { FleetConnection } from "./fleetConnection";

/*
 * Each host health state through the real console pipeline: Fleet's host-status reads, the
 * console's telemetry and alerts, and the alert actions. Reads, server configs and commands are
 * stand-ins each test sets in setup().
 */
const T0 = Date.parse("2026-10-22T12:00:00.000Z");
const GB = 1024 ** 3;

type Read = AtomType.Atom<
  AsyncResultType.AsyncResult<{ readonly hosts: ReadonlyArray<HostStatusEntry> }>
>;

const fixture = vi.hoisted(() => ({
  primary: "laptop-env",
  studio: "studio-env",
  reads: new Map<string, unknown>(),
  stalls: new Map<string, unknown>(),
  snapshot: null as unknown,
  clock: { now: 0 },
  calls: [] as Array<{ readonly command: string; readonly value: unknown }>,
  results: new Map<string, () => Promise<unknown>>(),
}));

vi.mock(
  import("~/state/hostStatus"),
  () =>
    ({
      HOST_STATUS_REFRESH_MS: 15_000,
      hostStatusAtom: (environmentId: string, options?: { readonly local?: boolean }) => {
        const read = fixture.reads.get(
          environmentId + (options?.local === true ? ":local" : ":fan-out"),
        );
        if (read === undefined) throw new Error("unexpected host-status read " + environmentId);
        return read;
      },
      refreshHostStatus: () => {},
    }) as never,
);

vi.mock(import("~/state/fleet"), async () => {
  const { Atom } = await import("effect/reactivity");
  const environments = [
    { environmentId: fixture.primary, label: "laptop", sshAliases: [] },
    { environmentId: fixture.studio, label: "studio", sshAliases: [] },
  ];
  return {
    fleetEnvironmentsAtom: Atom.make(environments),
    fleetPageEnvironmentsAtom: Atom.make(environments),
    fleetPageAtom: Atom.make(() => ({ snapshot: fixture.snapshot })),
  } as never;
});

vi.mock(import("~/state/primaryEnvironment"), async () => {
  const { Atom } = await import("effect/reactivity");
  return { primaryEnvironmentIdAtom: Atom.make(fixture.primary) } as never;
});

vi.mock(import("~/state/threads"), async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentThreadShells: { threadShellsAtom: Atom.make([]) } } as never;
});

vi.mock(import("~/state/server"), async () => {
  const { Atom } = await import("effect/reactivity");
  const command = (label: string) => ({ label, permissionAtom: () => Atom.make(true) });
  return {
    environmentServerConfigsAtom: Atom.make(
      () => new Map([...fixture.stalls].map(([id, stall]) => [id, { lastEventLoopStall: stall }])),
    ),
    serverEnvironment: {
      compactStorage: command("compact"),
      cleanUpStrayProcesses: command("clean-up"),
    },
  } as never;
});

vi.mock(
  import("~/connection/catalog"),
  () =>
    ({
      environmentCatalog: { retryNow: { label: "retry" } },
    }) as never,
);

vi.mock(
  import("~/state/use-atom-command"),
  () =>
    ({
      useAtomCommand: (command: { readonly label: string }) => (value: unknown) => {
        fixture.calls.push({ command: command.label, value });
        return (
          fixture.results.get(command.label)?.() ??
          Promise.resolve({ _tag: "Success", value: undefined })
        );
      },
    }) as never,
);

import FleetConsole from "./FleetConsole";

const sample = (extra: Partial<NonNullable<HostStatusEntry["metrics"]>> = {}): HostStatusEntry => ({
  host: null,
  reachability: "ok",
  metrics: {
    sampledAt: T0,
    cpuUtilization: 0.3,
    cpuCount: 10,
    availableMemoryBytes: 8,
    totalMemoryBytes: 16,
    loadAvg: { oneMinute: 2, fiveMinutes: 2, fifteenMinutes: 2 },
    disk: null,
    threads: { running: 0, waiting: 0, queued: 0 },
    quotas: [],
    ...extra,
  },
});

const storage = (extra: Partial<HostStorageHealth> = {}): HostStorageHealth => ({
  databaseBytes: 6.8 * GB,
  memoryBytes: 12 * 1024 ** 2,
  historyBytes: 6.7 * GB,
  reclaimableBytes: 0,
  measuredAt: new Date(T0).toISOString(),
  ...extra,
});

const machine = (id: string, environmentId: string) => ({
  id,
  label: id,
  subtitle: null,
  kind: "environment" as const,
  os: null,
  machineKind: null,
  environmentId: EnvironmentId.make(environmentId),
  sshHost: null,
  reportedAliases: [],
  boat: null,
  running: 0,
  attention: 0,
  reported: 0,
  agents: [],
});

async function setup(
  studio: {
    readonly read?: "answered" | "waiting" | "none";
    readonly entry?: HostStatusEntry;
  } = {},
) {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const answered = (entry: HostStatusEntry): Read =>
    Atom.make(AsyncResult.success({ hosts: [entry] }));
  const studioEntry = studio.entry ?? sample();
  fixture.reads = new Map<string, unknown>([
    [fixture.primary + ":local", answered(sample())],
    [fixture.primary + ":fan-out", answered(sample())],
    [
      fixture.studio + ":local",
      studio.read === "waiting"
        ? Atom.make(AsyncResult.success({ hosts: [studioEntry] }, { waiting: true }))
        : studio.read === "none"
          ? Atom.make(AsyncResult.initial(true))
          : answered(studioEntry),
    ],
    [fixture.studio + ":fan-out", answered(studioEntry)],
  ]);
  fixture.stalls = new Map();
  fixture.calls = [];
  fixture.results = new Map();
  fixture.clock.now = T0;
  fixture.snapshot = {
    machines: [machine("laptop", fixture.primary), machine("studio", fixture.studio)],
    threads: [],
    totals: { running: 0, attention: 0, reported: 0, machines: 2 },
  };
  return fixture.snapshot as never;
}

// A registry per test, so each one's reads are the ones its atoms compute from.
const view = (connections: ReadonlyMap<string, FleetConnection> = new Map()) => (
  <RegistryProvider>
    <FleetConsole snapshot={fixture.snapshot as never} connections={connections} heat={new Map()} />
  </RegistryProvider>
);

describe("FleetConsole host health", () => {
  it("says all clear while every host answers", async () => {
    await setup();
    using _now = vi.spyOn(Date, "now").mockImplementation(() => fixture.clock.now);
    await using screen = await render(view());
    await expect
      .element(screen.getByRole("region", { name: "Status" }).getByText("All clear"))
      .toBeVisible();
  });

  it("times a connection attempt, then calls it slow and offers Retry", async () => {
    // A connection that is not up has no host status of its own yet.
    await setup({ read: "none" });
    using _now = vi.spyOn(Date, "now").mockImplementation(() => fixture.clock.now);
    const connections = new Map<string, FleetConnection>([
      [
        "studio",
        {
          state: "connecting",
          label: "Connecting",
          reason: null,
          step: "Opening connection",
          since: T0 - 72_000,
        },
      ],
    ]);
    await using screen = await render(view(connections));
    const hosts = screen.getByRole("region", { name: "Hosts" });
    await expect
      .element(hosts.getByText("Still connecting · 1m 12s · Opening connection"))
      .toBeVisible();
    const status = screen.getByRole("region", { name: "Status" });
    await userEvent.click(status.getByRole("button", { name: "Retry connecting to studio" }));
    expect(fixture.calls).toEqual([{ command: "retry", value: fixture.studio }]);
  });

  it("says how long an unreachable host has been away", async () => {
    await setup();
    using _now = vi.spyOn(Date, "now").mockImplementation(() => fixture.clock.now);
    const connections = new Map<string, FleetConnection>([
      [
        "studio",
        {
          state: "unreachable",
          label: "Unreachable",
          reason: "No route to host",
          since: T0 - 240_000,
        },
      ],
    ]);
    await using screen = await render(view(connections));
    await expect
      .element(
        screen
          .getByRole("region", { name: "Status" })
          .getByText("Unreachable for 4m 0s · No route to host"),
      )
      .toBeVisible();
  });

  it("shows a stopped machine as stopped, with nothing to retry", async () => {
    await setup();
    using _now = vi.spyOn(Date, "now").mockImplementation(() => fixture.clock.now);
    const connections = new Map<string, FleetConnection>([
      [
        "studio",
        {
          state: "stopped",
          label: "Stopped",
          reason: "Resume it in Settings → Connections → Cloud machines.",
        },
      ],
    ]);
    await using screen = await render(view(connections));
    const status = screen.getByRole("region", { name: "Status" });
    await expect.element(status.getByText("Stopped")).toBeVisible();
    expect(status.getByRole("button").elements()).toHaveLength(0);
  });

  it("says a connected host stopped answering, with the time it has waited and the likely cause", async () => {
    await setup({ read: "waiting" });
    using _now = vi.spyOn(Date, "now").mockImplementation(() => fixture.clock.now);
    fixture.stalls.set(fixture.studio, {
      detectedAt: new Date(T0 - 60_000).toISOString(),
      durationMs: 19_000,
      loadAverage: 23,
      cpuCount: 10,
    });
    await using screen = await render(view());
    const status = screen.getByRole("region", { name: "Status" });
    // A stall it reported on connect explains it before the wait is long.
    await expect
      .element(status.getByText("Froze for 19s · Its CPU is overloaded (load 23 on 10 cores)."))
      .toBeVisible();
    fixture.clock.now = T0 + 18_000;
    await expect
      .element(
        status.getByText("Not answering · 18s · Its CPU is overloaded (load 23 on 10 cores)."),
      )
      .toBeVisible();
  });

  it("flags history over budget and compacts it with progress and a result", async () => {
    await setup({ entry: sample({ storage: storage() }) });
    using _now = vi.spyOn(Date, "now").mockImplementation(() => fixture.clock.now);
    let finish!: (value: unknown) => void;
    fixture.results.set("compact", () => new Promise((resolve) => (finish = resolve)));
    await using screen = await render(view());
    const status = screen.getByRole("region", { name: "Status" });
    await expect
      .element(
        status.getByText(
          "Thread history is 6.7 GB, 3.4× its 2 GB budget; this slows GOAT down there",
        ),
      )
      .toBeVisible();
    await userEvent.click(status.getByRole("button", { name: "Compact on studio" }));
    await expect.element(status.getByText("Compacting · 0s")).toBeVisible();
    expect(fixture.calls).toEqual([
      { command: "compact", value: { environmentId: fixture.studio, input: {} } },
    ]);
    finish({
      _tag: "Success",
      value: storage({
        historyBytes: 1.1 * GB,
        lastCompaction: {
          finishedAt: new Date(T0).toISOString(),
          removedEvents: 1_204_311,
          freedBytes: 0,
          needsOfflineCompaction: true,
        },
      }),
    });
    await expect
      .element(
        status.getByText(
          "Removed 1,204,311 old events; the file shrinks after goat doctor runs on that machine",
        ),
      )
      .toBeVisible();
  });

  it("lists stray GOAT servers as one quiet item and cleans them up", async () => {
    await setup({
      entry: sample({
        strays: {
          scannedAt: new Date(T0).toISOString(),
          processes: [
            {
              pid: 72341,
              startedAt: new Date(T0 - 63 * 3_600_000).toISOString(),
              kind: "orphaned_server",
              reason: "home_deleted",
              baseDir: "/private/tmp/goat-test-7kyqAJ/.goat",
            },
          ],
        },
      }),
    });
    using _now = vi.spyOn(Date, "now").mockImplementation(() => fixture.clock.now);
    fixture.results.set("clean-up", () =>
      Promise.resolve({
        _tag: "Success",
        value: { stopped: 1, forced: 1, failed: [], remaining: { scannedAt: "x", processes: [] } },
      }),
    );
    await using screen = await render(view());
    const status = screen.getByRole("region", { name: "Status" });
    await expect.element(status.getByText("1 stray GOAT server · 2d 15h")).toBeVisible();
    expect(status.getByRole("listitem").elements()).toHaveLength(1);
    await userEvent.click(status.getByRole("button", { name: "Clean up on studio" }));
    await expect.element(status.getByText("Stopped 1 (1 forced)")).toBeVisible();
  });
});
