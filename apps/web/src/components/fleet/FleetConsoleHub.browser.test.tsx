import type { FleetMachine, FleetSnapshot } from "@goat/client-runtime/state/fleet";
import {
  EnvironmentId,
  type HostStatusEntry,
  type OpenCodexInventorySnapshot,
} from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { useUiStateStore } from "../../uiStateStore";

const fixture = vi.hoisted(() => ({
  reports: new Map<EnvironmentId, ReadonlyArray<HostStatusEntry>>(),
}));

vi.mock(import("./fleetConsoleTelemetry"), async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    fleetConsoleTelemetryAtom: Atom.make(() => ({
      reports: fixture.reports,
      history: new Map(),
      lastSeen: new Map(),
      loading: false,
      failed: [],
      pendingSince: new Map(),
      sampledAt: 0,
      observedAt: 0,
    })),
  };
});

vi.mock(import("~/state/fleet"), async () => {
  const { Atom } = await import("effect/reactivity");
  const environments = [{ environmentId: "home-host", label: "home-host", sshAliases: [] }];
  return {
    fleetEnvironmentsAtom: Atom.make(environments),
    fleetPageEnvironmentsAtom: Atom.make(environments),
  } as never;
});

vi.mock(import("~/state/primaryEnvironment"), async () => {
  const { Atom } = await import("effect/reactivity");
  return { primaryEnvironmentIdAtom: Atom.make("home-host") } as never;
});

vi.mock(import("~/state/threads"), async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentThreadShells: { threadShellsAtom: Atom.make([]) } } as never;
});

import FleetConsole from "./FleetConsole";

function opencodex(role: "home" | "child"): OpenCodexInventorySnapshot {
  return {
    installed: true,
    binaries: [],
    ownership: "adopted",
    service: { available: false },
    runtime: {
      version: role === "home" ? "2.89.0" : "2.83.0",
      role: role === "home" ? "standalone" : "client",
      port: 10100,
      healthy: true,
      ready: true,
    },
    link: {
      role,
      available: true,
      links:
        role === "home"
          ? [
              { id: "lnk_a", alias: "child-a", tunnelPort: 54958, state: "connected" },
              { id: "lnk_b", alias: "child-b", tunnelPort: 42255, state: "reconnecting" },
            ]
          : [],
      childSettingsApplied: null,
      homeName: "jun-mbp",
    },
  };
}

function entry(host: string | null, extra: Partial<HostStatusEntry> = {}): HostStatusEntry {
  return {
    host,
    reachability: "ok",
    metrics: {
      sampledAt: 0,
      cpuUtilization: 0.2,
      cpuCount: 8,
      availableMemoryBytes: 8,
      totalMemoryBytes: 16,
      loadAvg: null,
      disk: null,
      threads: { running: 0, waiting: 0, queued: 0 },
      quotas: [],
      opencodex: opencodex(host === null ? "home" : "child"),
    },
    ...extra,
  };
}

function setup(): FleetSnapshot {
  const machines: FleetMachine[] = [
    {
      id: "home-host",
      label: "jun-mbp",
      environmentId: EnvironmentId.make("home-host"),
      subtitle: null,
      kind: "environment",
      os: null,
      machineKind: null,
      sshHost: null,
      reportedAliases: [],
      answering: true,
      boat: null,
      running: 0,
      attention: 0,
      reported: 0,
      agents: [],
    },
  ];
  fixture.reports = new Map([
    [
      EnvironmentId.make("home-host"),
      [
        entry(null),
        entry("child-a", {
          parity: {
            verdict: "degraded",
            checkedAt: 0,
            failingCheckIds: ["P6"],
            checks: [{ id: "P6", status: "failed", reason: "settings never synced" }],
          },
        }),
        entry("child-b"),
      ],
    ],
  ]);
  useUiStateStore.setState({ fleetConsoleCollapsed: false });
  return { machines, threads: [], totals: { machines: 1, running: 0, attention: 0, reported: 0 } };
}

it("folds every hub device into one Hub entry and names the Home on its Children", async () => {
  const snapshot = setup();
  await using screen = await render(
    <FleetConsole snapshot={snapshot} connections={new Map()} heat={new Map()} />,
  );
  const hosts = screen.getByRole("region", { name: "Hosts" });
  for (const label of ["child-a", "child-b"]) {
    const row = hosts.getByRole("listitem").filter({ has: page.getByText(label, { exact: true }) });
    await expect.element(row.getByText("via Hub jun-mbp")).toBeVisible();
  }
  const status = screen.getByRole("region", { name: "Status" });
  await expect.element(status.getByText("jun-mbp", { exact: true })).toBeVisible();
  // A degraded verdict and a reconnecting tunnel both need a person.
  await expect.element(status.getByText("2 need attention")).toBeVisible();
  expect(screen.container.querySelectorAll("[data-fleet-hub]")).toHaveLength(1);

  await userEvent.click(status.getByRole("button", { name: "Show 2 hub devices" }));
  const devices = page.getByRole("list", { name: "Hub devices" });
  const childA = devices.getByRole("listitem").filter({ hasText: "child-a" });
  await expect.element(childA.getByText("Remote Link Child")).toBeVisible();
  await expect
    .element(
      childA.getByText(
        "parity degraded (P6) · tunnel connected · OpenCodex 2.83.0, degraded · OpenCodex fallback unknown",
      ),
    )
    .toBeVisible();
  await expect
    .element(
      devices
        .getByRole("listitem")
        .filter({ hasText: "child-b" })
        .getByText(/tunnel reconnecting/),
    )
    .toBeVisible();
  await expect.element(page.getByRole("link", { name: "Hub settings" })).toBeVisible();
});
