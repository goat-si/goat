import type { FleetMachine, FleetSnapshot } from "@goat/client-runtime/state/fleet";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type HostStatusEntry,
  type QuotaPool,
} from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { __setClientSettingsForTests, persistClientSettingsPatch } from "~/hooks/useSettings";
import { I18nProvider } from "~/i18n/I18nProvider";
import { startI18n, whenLocaleReady } from "~/i18n/runtime";
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
  const environments = ["home-host", "child-a", "child-b"].map((id) => ({
    environmentId: id,
    label: id,
    sshAliases: [],
  }));
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

function setup(): FleetSnapshot {
  const observedAt = "2026-10-21T08:00:00.000Z";
  const pool: QuotaPool = {
    schema: "ocx.quota-pool/1",
    producer: {
      version: "3.0.0",
      role: "hub",
      homeId: "home-host",
      displayName: "Hub workstation",
    },
    generatedAt: observedAt,
    providers: [
      {
        provider: "openai",
        pooled: {
          windows: [
            {
              id: "5h",
              kind: "burst_5h",
              label: "5h",
              usedPercent: 21,
              source: "measured",
              observedAt,
            },
            {
              id: "weekly",
              kind: "weekly",
              label: "Weekly",
              usedPercent: 43,
              source: "measured",
              observedAt,
            },
          ],
        },
        accounts: [
          {
            provider: "openai",
            accountRef: "account-a",
            label: "Account A",
            state: "available",
            windows: [
              {
                id: "5h",
                kind: "burst_5h",
                label: "5h",
                usedPercent: 35,
                source: "header",
                observedAt,
              },
            ],
          },
        ],
      },
    ],
  };
  const machines: FleetMachine[] = ["home-host", "child-a", "child-b"].map((id) => ({
    id,
    label: id === "home-host" ? "Hub workstation" : id,
    environmentId: EnvironmentId.make(id),
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
  }));
  fixture.reports = new Map(
    machines.map((machine) => [
      machine.environmentId!,
      [
        {
          host: null,
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
            quotaPool: pool,
            quotas: [
              {
                instanceId: ProviderInstanceId.make("codex"),
                driver: ProviderDriverKind.make("codex"),
                fromCache: false,
                limits: {
                  checkedAt: observedAt,
                  quotaPool: { provider: "openai", homeId: "home-host" },
                  windows: [
                    { id: "local", kind: "weekly", label: "Local weekly", usedPercent: 98 },
                  ],
                },
              },
            ],
          },
        },
      ],
    ]),
  );
  useUiStateStore.setState({ fleetConsoleCollapsed: false });
  return {
    machines,
    threads: [],
    totals: { machines: 3, running: 0, attention: 0, reported: 0 },
    hiddenCloudAliases: [],
    hiddenRoutes: [],
    idleCloudMachines: [],
  };
}

it("shows one Home pool with via Hub device references and account detail without extra quota rows", async () => {
  const snapshot = setup();
  await using screen = await render(
    <FleetConsole snapshot={snapshot} connections={new Map()} heat={new Map()} />,
  );
  const hosts = screen.getByRole("region", { name: "Hosts" });
  for (const label of ["Hub workstation", "child-a", "child-b"]) {
    const row = hosts.getByRole("listitem").filter({ has: page.getByText(label, { exact: true }) });
    await expect.element(row.getByText("via Hub Hub workstation")).toBeVisible();
  }
  const status = screen.getByRole("region", { name: "Status" });
  await expect
    .element(status.getByRole("meter", { name: "OpenCodex pool quota used" }))
    .toHaveAttribute("aria-valuenow", "43");
  expect(screen.container.querySelectorAll("[data-fleet-quota]")).toHaveLength(1);
  await expect.element(status.getByText("Weekly 43% · 5h 21% +1 account")).toBeVisible();
  await expect.element(status.getByText("Local weekly", { exact: false })).not.toBeInTheDocument();
  await userEvent.hover(status.getByLabelText("Show 1 more quota details"));
  await expect
    .element(page.getByText("0 more windows · 1 account", { exact: false }))
    .toBeVisible();
  await expect
    .element(page.getByText("Account A (available): 5h: 35% (header)", { exact: false }))
    .toBeVisible();
  expect(screen.container.querySelectorAll("[data-fleet-quota]")).toHaveLength(1);
});

it("updates quota details and their accessible name when the display language changes", async () => {
  const snapshot = setup();
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  startI18n();
  await using screen = await render(
    <I18nProvider>
      <FleetConsole snapshot={snapshot} connections={new Map()} heat={new Map()} />
    </I18nProvider>,
  );
  try {
    await expect.element(screen.getByLabelText("Show 1 more quota details")).toBeVisible();
    await persistClientSettingsPatch({ language: "zh" }, async () => {});
    await whenLocaleReady();
    const details = screen.getByLabelText("显示另外 1 项配额详情");
    await expect.element(details).toHaveTextContent("+1 个账户");
    await userEvent.hover(details);
    await expect
      .element(page.getByText("Account A (可用): 5h: 35% (响应头)", { exact: false }))
      .toBeVisible();
  } finally {
    await persistClientSettingsPatch({ language: "en" }, async () => {});
    await whenLocaleReady();
  }
});
