import { EnvironmentId, type HostStatusEntry } from "@goat/contracts";
import type { AsyncResult as AsyncResultType, Atom as AtomType } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import type { FleetConnection } from "./fleetConnection";

/*
 * The real host-status pipeline (Fleet's reads, the console's telemetry, the rows) over
 * host-status reads that answer, or never do, as each case needs. The primary's fan-out to
 * its SSH hosts never answers, as when one of them is stuck connecting.
 */
const fixture = vi.hoisted(() => ({
  primary: "laptop-env",
  studio: "studio-env",
}));

vi.mock(import("~/state/hostStatus"), async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const sample = (cpuUtilization: number): HostStatusEntry => ({
    host: null,
    reachability: "ok",
    metrics: {
      sampledAt: Date.parse("2026-10-21T08:00:00.000Z"),
      cpuUtilization,
      cpuCount: 8,
      availableMemoryBytes: 8,
      totalMemoryBytes: 16,
      loadAvg: { oneMinute: 2, fiveMinutes: 2, fifteenMinutes: 2 },
      disk: null,
      threads: { running: 0, waiting: 0, queued: 0 },
      quotas: [],
    },
  });
  type Read = AtomType.Atom<
    AsyncResultType.AsyncResult<{ readonly hosts: ReadonlyArray<HostStatusEntry> }>
  >;
  const answered = (entry: HostStatusEntry): Read =>
    Atom.make(AsyncResult.success({ hosts: [entry] }));
  const reads = new Map<string, Read>([
    [fixture.primary + ":local", answered(sample(0.23))],
    [fixture.primary + ":fan-out", Atom.make(AsyncResult.initial(true))],
    [fixture.studio + ":local", answered(sample(0.47))],
  ]);
  return {
    HOST_STATUS_REFRESH_MS: 15_000,
    hostStatusAtom: (environmentId: string, options?: { readonly local?: boolean }) => {
      const read = reads.get(environmentId + (options?.local === true ? ":local" : ":fan-out"));
      if (read === undefined) throw new Error("unexpected host-status read " + environmentId);
      return read;
    },
    refreshHostStatus: () => {},
  } as never;
});

const machine = (id: string, overrides: object) => ({
  id,
  label: id,
  subtitle: null,
  kind: "environment" as const,
  os: null,
  machineKind: null,
  environmentId: null,
  sshHost: null,
  reportedAliases: [],
  boat: null,
  answering: false,
  running: 0,
  attention: 0,
  reported: 0,
  agents: [],
  ...overrides,
});

const snapshot = vi.hoisted(() => ({ value: null as unknown }));

vi.mock(import("~/state/fleet"), async () => {
  const { Atom } = await import("effect/reactivity");
  const environments = [
    { environmentId: fixture.primary, label: "laptop", sshAliases: [] },
    { environmentId: fixture.studio, label: "studio", sshAliases: [] },
  ];
  return {
    fleetEnvironmentsAtom: Atom.make(environments),
    fleetPageEnvironmentsAtom: Atom.make(environments),
    fleetPageAtom: Atom.make(() => ({ snapshot: snapshot.value })),
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

import FleetConsole from "./FleetConsole";

function setup() {
  const value = {
    machines: [
      machine("laptop", { environmentId: EnvironmentId.make(fixture.primary), answering: true }),
      machine("studio", { environmentId: EnvironmentId.make(fixture.studio), answering: true }),
      machine("headless", {
        kind: "ssh",
        sshHost: { via: EnvironmentId.make(fixture.primary), alias: "headless" },
      }),
    ],
    threads: [],
    totals: { running: 0, attention: 0, reported: 0, machines: 3 },
  };
  snapshot.value = value;
  return value;
}

const connecting: FleetConnection = { state: "connecting", label: "Connecting", reason: null };

describe("FleetConsole host rows", () => {
  it("shows each host that answered while another host's read never does", async () => {
    const fleet = setup();
    await using screen = await render(
      <FleetConsole
        snapshot={fleet as never}
        connections={new Map([["headless", connecting]])}
        heat={new Map()}
      />,
    );
    const hosts = screen.getByRole("region", { name: "Hosts" });
    const row = (label: string) => hosts.getByRole("listitem").filter({ hasText: label });

    // This machine's own read answered even though its fan-out has not.
    await expect.element(row("laptop").getByText("23%")).toBeVisible();
    // Another environment is read without waiting for the primary's fan-out.
    await expect.element(row("studio").getByText("47%")).toBeVisible();
    await expect.element(row("headless").getByText("Connecting")).toBeVisible();
    await expect.element(hosts.getByText("Hosts 2/3")).toBeVisible();
  });
});
