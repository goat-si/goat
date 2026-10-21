import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type GoatHostStatusResult,
  type HostStatusEntry,
  type HubParityResult,
  type OpenCodexInventorySnapshot,
  type ServerSettings,
} from "@goat/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";

const state = vi.hoisted(() => ({
  settings: undefined as unknown,
  hosts: undefined as unknown,
  permission: vi.fn(),
  update: vi.fn(),
  verify: vi.fn(),
  scope: vi.fn(),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    updateSettings: {
      label: "settings:update",
      run: state.update,
      permissionAtom: state.permission,
    },
    verifyHubDevice: { label: "hub:verify", run: state.verify, permissionAtom: state.permission },
  },
}));
vi.mock("~/hooks/useSettings", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    useEnvironmentSettings: (_id: string, select: (settings: ServerSettings) => unknown) =>
      select(useAtomValue(state.settings as Atom.Atom<ServerSettings>)),
  };
});
vi.mock("~/state/hostStatus", () => ({
  HOST_STATUS_REFRESH_MS: 15_000,
  hostStatusAtom: () => state.hosts,
  refreshHostStatus: () => undefined,
}));
vi.mock("~/hooks/useLiveRefresh", () => ({ useLiveRefresh: () => undefined }));
vi.mock("~/state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("./SettingsScopeContext", () => ({ useSettingsScope: state.scope }));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  SettingsSection: (props: { title: string; children: ReactNode; headerAction?: ReactNode }) => (
    <section>
      <h2>{props.title}</h2>
      {props.headerAction}
      {props.children}
    </section>
  ),
  SettingsRow: (props: {
    title: ReactNode;
    description?: ReactNode;
    status?: ReactNode;
    control?: ReactNode;
  }) => (
    <div>
      <h3>{props.title}</h3>
      <p>{props.description}</p>
      {props.status}
      {props.control}
    </div>
  ),
}));

import { HubSettings } from "./HubSettings";

const environmentId = EnvironmentId.make("hub-environment");

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
              { id: "lnk_a", alias: "macmini-ts", tunnelPort: 54958, state: "connected" },
              { id: "lnk_b", alias: "lidge-ts", tunnelPort: 42255, state: "connected" },
            ]
          : [],
      childSettingsApplied: role === "child" ? false : null,
      homeName: "jun-mbp",
    },
  };
}

function host(name: string | null, parity?: HubParityResult): HostStatusEntry {
  return {
    host: name,
    reachability: "ok",
    metrics: {
      sampledAt: 0,
      cpuCount: 8,
      cpuUtilization: null,
      availableMemoryBytes: 8,
      totalMemoryBytes: 16,
      loadAvg: null,
      disk: null,
      threads: { running: 0, waiting: 0, queued: 0 },
      quotas: [],
      opencodex: opencodex(name === null ? "home" : "child"),
    },
    ...(parity ? { parity } : {}),
  };
}

const degraded: HubParityResult = {
  verdict: "degraded",
  checkedAt: Date.parse("2026-10-21T08:00:00.000Z"),
  failingCheckIds: ["P6"],
  checks: [
    { id: "P1", status: "ok", reason: "role client" },
    { id: "P6", status: "failed", reason: "No Home settings sync has applied here yet." },
  ],
};

function setup() {
  const registry = AtomRegistry.make();
  const settings = Atom.make<ServerSettings>(DEFAULT_SERVER_SETTINGS);
  const source = Atom.make(
    AsyncResult.success<GoatHostStatusResult>({
      hosts: [host(null), host("macmini-ts", degraded), host("lidge-ts")],
    }),
  );
  // Derived, so the page's refresh after Verify rereads the source like a real query.
  const hosts = Atom.make((get) => get(source));
  state.settings = settings;
  state.hosts = hosts;
  state.permission.mockReset().mockReturnValue(Atom.make(true));
  state.scope.mockReset().mockReturnValue({
    environment: {
      environmentId,
      label: "jun-mbp",
      connection: { phase: "connected" },
      serverConfig: {},
      entry: { target: { _tag: "PrimaryConnectionTarget" } },
    },
  });
  state.update
    .mockReset()
    .mockImplementation(
      async (
        _registry: unknown,
        { input }: { input: { patch: { hub: Partial<ServerSettings["hub"]> } } },
      ) => {
        const next = registry.get(settings);
        registry.set(settings, { ...next, hub: { ...next.hub, ...input.patch.hub } });
        return { _tag: "Success", value: undefined };
      },
    );
  state.verify.mockReset().mockImplementation(async () => {
    const parity: HubParityResult = {
      verdict: "ok",
      checkedAt: Date.parse("2026-10-21T09:00:00.000Z"),
      failingCheckIds: [],
      checks: [],
    };
    registry.set(
      source,
      AsyncResult.success({
        hosts: [host(null), host("macmini-ts", degraded), host("lidge-ts", parity)],
      }),
    );
    return { _tag: "Success", value: { deviceAlias: "lidge-ts", parity } };
  });
  return { registry, [Symbol.dispose]: () => registry.dispose() };
}

const device = (screen: Awaited<ReturnType<typeof render>>, alias: string) =>
  screen.getByRole("listitem").filter({ hasText: alias });

it("shows each device's verdict and failing checks, and Verify replaces a missing verdict", async () => {
  using fixture = setup();
  await using screen = await render(
    <RegistryContext value={fixture.registry}>
      <HubSettings />
    </RegistryContext>,
  );
  await expect.element(screen.getByText("OpenCodex 2.89.0 Home · jun-mbp")).toBeVisible();
  const macmini = device(screen, "macmini-ts");
  await expect.element(macmini.getByText("Parity degraded (P6)")).toBeVisible();
  await expect
    .element(macmini.getByText("No Home settings sync has applied here yet."))
    .toBeVisible();
  await expect.element(macmini.getByText(/OpenCodex 2\.83\.0.*tunnel connected/)).toBeVisible();
  const lidge = device(screen, "lidge-ts");
  await expect.element(lidge.getByText("Parity not verified")).toBeVisible();
  await expect.element(lidge.getByText(/never verified/)).toBeVisible();
  await userEvent.click(lidge.getByRole("button", { name: "Verify" }));
  await expect.element(lidge.getByText("Parity ok")).toBeVisible();
  expect(state.verify.mock.calls[0]?.[1]).toEqual({
    environmentId,
    input: { deviceAlias: "lidge-ts" },
  });
  await expect.element(lidge.getByText("OpenCodex fallback: unknown")).toBeVisible();
});

it("turns the hub and a device's own sign-in on and back off", async () => {
  using fixture = setup();
  await using screen = await render(
    <RegistryContext value={fixture.registry}>
      <HubSettings />
    </RegistryContext>,
  );
  const hubSwitch = screen.getByRole("switch", { name: "This machine is the hub" });
  const cloudRuns = screen.getByRole("combobox", { name: "Cloud runs" });
  await expect.element(hubSwitch).not.toBeChecked();
  await expect.element(cloudRuns).toBeDisabled();
  await userEvent.click(hubSwitch);
  await expect.element(hubSwitch).toBeChecked();
  await expect.element(cloudRuns).toBeEnabled();
  await userEvent.click(hubSwitch);
  await expect.element(hubSwitch).not.toBeChecked();

  const fallback = device(screen, "macmini-ts").getByRole("switch", {
    name: /own sign-in when the hub is down/,
  });
  await userEvent.click(fallback);
  await expect.element(fallback).toBeChecked();
  await userEvent.click(fallback);
  await expect.element(fallback).not.toBeChecked();
  expect(state.update.mock.calls.map((call) => call[1].input.patch)).toEqual([
    { hub: { enabled: true } },
    { hub: { enabled: false } },
    { hub: { devices: { "macmini-ts": { localFallback: true } } } },
    { hub: { devices: { "macmini-ts": { localFallback: false } } } },
  ]);
});
