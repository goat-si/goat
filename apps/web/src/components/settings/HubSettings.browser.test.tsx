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
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "../../index.css";

const state = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  hosts: undefined as unknown,
  permission: vi.fn(),
  update: vi.fn(),
  verify: vi.fn(),
  join: vi.fn(),
  leave: vi.fn(),
  repair: vi.fn(),
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
    joinHubDevice: { label: "hub:join", run: state.join, permissionAtom: state.permission },
    leaveHubDevice: { label: "hub:leave", run: state.leave, permissionAtom: state.permission },
    repairHubDevice: { label: "hub:repair", run: state.repair, permissionAtom: state.permission },
  },
}));
vi.mock("~/hooks/useSettings", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    useEnvironmentSettings: (id: string, select: (settings: ServerSettings) => unknown) =>
      select(useAtomValue(state.settings.get(id) as Atom.Atom<ServerSettings>)),
  };
});
vi.mock("~/state/hostStatus", () => ({
  HOST_STATUS_REFRESH_MS: 15_000,
  hostStatusAtom: () => state.hosts,
  refreshHostStatus: () => undefined,
}));
// macmini-ts has its own GOAT connection; lidge-ts does not.
vi.mock("~/state/fleet", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    fleetEnvironmentsAtom: Atom.make([
      { environmentId: "macmini-environment", label: "Mac mini", sshAliases: ["macmini-ts"] },
    ]),
  };
});
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
const macminiEnvironment = EnvironmentId.make("macmini-environment");

function opencodex(
  role: "home" | "child",
  linked: ReadonlyArray<string> = ["macmini-ts", "lidge-ts"],
): OpenCodexInventorySnapshot {
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
          ? linked.map((alias, index) => ({
              id: `lnk_${index}`,
              alias,
              tunnelPort: 42000 + index,
              state: "connected" as const,
            }))
          : [],
      childSettingsApplied: role === "child" ? false : null,
      homeName: "jun-mbp",
    },
  };
}

function host(
  name: string | null,
  parity?: HubParityResult,
  linked?: ReadonlyArray<string>,
): HostStatusEntry {
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
      opencodex: {
        ...opencodex(name === null ? "home" : "child", linked),
        // The Home allows this Child to use its own providers (OCX-11).
        ...(name === "macmini-ts" ? { fallback: { source: "home", localFallback: true } } : {}),
      },
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
  const settings = new Map(
    [environmentId, macminiEnvironment].map((id) => [
      id,
      Atom.make<ServerSettings>(DEFAULT_SERVER_SETTINGS),
    ]),
  );
  const source = Atom.make(
    AsyncResult.success<GoatHostStatusResult>({
      // studio-mini answers but is not linked: a standalone device that can join.
      hosts: [host(null), host("macmini-ts", degraded), host("lidge-ts"), host("studio-mini")],
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
  state.update.mockReset().mockImplementation(
    async (
      _registry: unknown,
      target: {
        environmentId: EnvironmentId;
        input: {
          patch: {
            hub?: Partial<ServerSettings["hub"]>;
            goatclaw?: Partial<ServerSettings["goatclaw"]>;
          };
        };
      },
    ) => {
      const atom = settings.get(target.environmentId)!;
      const next = registry.get(atom);
      registry.set(atom, {
        ...next,
        hub: { ...next.hub, ...target.input.patch.hub },
        goatclaw: { ...next.goatclaw, ...target.input.patch.goatclaw },
      });
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
        hosts: [
          host(null),
          host("macmini-ts", degraded),
          host("lidge-ts", parity),
          host("studio-mini"),
        ],
      }),
    );
    return { _tag: "Success", value: { deviceAlias: "lidge-ts", parity } };
  });
  for (const command of [state.join, state.leave, state.repair]) command.mockReset();
  return { registry, source, [Symbol.dispose]: () => registry.dispose() };
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
  await expect.element(macmini.getByText("OpenCodex allows it: yes")).toBeVisible();
  await expect
    .element(lidge.getByText("Connect to lidge-ts in GOAT to change this", { exact: false }))
    .toBeVisible();
  await expect
    .element(lidge.getByRole("switch", { name: /own sign-in when the hub is down/ }))
    .toBeDisabled();
});

it("turns the hub on and off here, and a device's own sign-in on and off on that device", async () => {
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
  // The hub-down policy reads the device's own "local" entry, so the switch writes there.
  expect(
    state.update.mock.calls.map((call) => [call[1].environmentId, call[1].input.patch]),
  ).toEqual([
    [environmentId, { hub: { enabled: true } }],
    [environmentId, { hub: { enabled: false } }],
    [macminiEnvironment, { hub: { devices: { local: { localFallback: true } } } }],
    [macminiEnvironment, { hub: { devices: { local: { localFallback: false } } } }],
  ]);
});

const PROBE = { step: "probe", outcome: "ok", detail: "ssh-ed25519 SHA256:studio" } as const;
const ok: HubParityResult = { verdict: "ok", checkedAt: 0, failingCheckIds: [], checks: [] };
const success = (value: unknown) => ({ _tag: "Success", value });

it("joins a standalone device through a decision, and a declined one starts again", async () => {
  using fixture = setup();
  state.join
    .mockResolvedValueOnce(
      success({
        deviceAlias: "studio-mini",
        action: "join",
        state: "needs_human",
        message: "GOAT has no pinned host key for this alias.",
        steps: [PROBE],
        decisionId: "decision-1",
      }),
    )
    .mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("That decision was not approved.")),
    })
    .mockResolvedValueOnce(
      success({
        deviceAlias: "studio-mini",
        action: "join",
        state: "needs_human",
        message: "GOAT has no pinned host key for this alias.",
        steps: [PROBE],
        decisionId: "decision-2",
      }),
    )
    .mockResolvedValueOnce(
      success({
        deviceAlias: "studio-mini",
        action: "join",
        state: "child",
        message: "studio-mini is linked to this Home.",
        steps: [PROBE, { step: "link_add", outcome: "ok", detail: "lnk_studio" }],
        parity: ok,
      }),
    );
  await using screen = await render(
    <RegistryContext value={fixture.registry}>
      <HubSettings />
    </RegistryContext>,
  );
  const studio = device(screen, "studio-mini");
  await expect.element(studio.getByRole("button", { name: "Repair" })).not.toBeInTheDocument();
  await userEvent.click(studio.getByRole("button", { name: "Join" }));
  const result = studio.getByRole("region", { name: "Join studio-mini result" });
  await expect.element(result.getByText("Needs a decision")).toBeVisible();
  await expect.element(result.getByText("SHA256:studio", { exact: false })).toBeVisible();
  await expect
    .element(result.getByRole("link", { name: "Open decision" }))
    .toHaveAttribute("href", "/settings/decision-inbox");

  await userEvent.click(result.getByRole("button", { name: "Continue" }));
  await expect
    .element(studio.getByText("That decision was not approved.", { exact: false }))
    .toBeVisible();
  await userEvent.click(studio.getByRole("button", { name: "Start again" }));
  await userEvent.click(
    studio
      .getByRole("region", { name: "Join studio-mini result" })
      .getByRole("button", { name: "Continue" }),
  );
  const linked = studio.getByRole("region", { name: "Join studio-mini result" });
  await expect.element(linked.getByText("Linked", { exact: true })).toBeVisible();
  await expect.element(linked.getByText("Approved in a decision.")).toBeVisible();
  await expect.element(linked.getByText("lnk_studio")).toBeVisible();
  expect(state.join.mock.calls.map((call) => call[1].input)).toEqual([
    { deviceAlias: "studio-mini" },
    { deviceAlias: "studio-mini", decisionId: "decision-1" },
    { deviceAlias: "studio-mini" },
    { deviceAlias: "studio-mini", decisionId: "decision-2" },
  ]);
});

it("repair lists each ladder step it ran and the parity it ended on", async () => {
  using fixture = setup();
  state.repair.mockResolvedValueOnce(
    success({
      deviceAlias: "macmini-ts",
      action: "repair",
      state: "degraded",
      message: "Steps 1-3 left P5 failing. A deferred restart can run once the device is idle.",
      steps: [
        { step: "sync", outcome: "ok" },
        { step: "restart", outcome: "deferred", detail: "A turn is running there." },
      ],
      parity: { ...degraded, failingCheckIds: ["P5"] },
    }),
  );
  await using screen = await render(
    <RegistryContext value={fixture.registry}>
      <HubSettings />
    </RegistryContext>,
  );
  const macmini = device(screen, "macmini-ts");
  await userEvent.click(macmini.getByRole("button", { name: "Repair" }));
  const result = macmini.getByRole("region", { name: "Repair macmini-ts result" });
  await expect.element(result.getByText("Repair 1 · ocx sync")).toBeVisible();
  await expect.element(result.getByText("deferred")).toBeVisible();
  await expect.element(result.getByText("A turn is running there.")).toBeVisible();
  await expect.element(result.getByText("degraded (P5)")).toBeVisible();
  expect(state.repair.mock.calls[0]?.[1]).toEqual({
    environmentId,
    input: { deviceAlias: "macmini-ts" },
  });
});

it("leave asks first, and its result stays once the device is no longer listed", async () => {
  using fixture = setup();
  state.leave.mockImplementationOnce(async () => {
    fixture.registry.set(
      fixture.source,
      AsyncResult.success({
        hosts: [host(null, undefined, ["macmini-ts"]), host("macmini-ts", degraded)],
      }),
    );
    return success({
      deviceAlias: "lidge-ts",
      action: "leave",
      state: "ready",
      message: "lidge-ts left the hub.",
      steps: [
        { step: "disconnect", outcome: "ok" },
        { step: "restart", outcome: "ok" },
        { step: "health", outcome: "ok", detail: "Device answers as standalone." },
        { step: "revoke", outcome: "ok", detail: "lnk_1" },
        { step: "link_removed", outcome: "ok" },
      ],
    });
  });
  await using screen = await render(
    <RegistryContext value={fixture.registry}>
      <HubSettings />
    </RegistryContext>,
  );
  await userEvent.click(device(screen, "lidge-ts").getByRole("button", { name: "Leave" }));
  await expect.element(screen.getByText("Remove lidge-ts from the hub?")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(state.leave).not.toHaveBeenCalled();

  await userEvent.click(device(screen, "lidge-ts").getByRole("button", { name: "Leave" }));
  await userEvent.click(screen.getByRole("button", { name: "Disconnect and remove" }));
  const recent = screen.getByRole("region", { name: "Recent actions" });
  await expect.element(recent.getByText("lidge-ts left the hub.")).toBeVisible();
  await expect.element(recent.getByText("Revoke on this Home")).toBeVisible();
  await expect.element(recent.getByText("Standalone")).toBeVisible();
});

it("Add device to hub joins a typed alias and shows why it failed", async () => {
  using fixture = setup();
  state.join.mockResolvedValueOnce(
    success({
      deviceAlias: "new-mini",
      action: "join",
      state: "failed",
      message:
        "new-mini does not resolve to a direct SSH host. Use a direct Tailscale alias without ProxyJump or ProxyCommand.",
      steps: [],
    }),
  );
  await using screen = await render(
    <RegistryContext value={fixture.registry}>
      <HubSettings />
    </RegistryContext>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Add device to hub" }));
  await userEvent.fill(
    screen.getByRole("combobox", { name: "SSH alias of the device" }),
    "new-mini",
  );
  await userEvent.click(screen.getByRole("button", { name: "Join", exact: true }).first());
  await expect
    .element(screen.getByText("does not resolve to a direct SSH host", { exact: false }).first())
    .toBeVisible();
  expect(state.join.mock.calls[0]?.[1].input).toEqual({ deviceAlias: "new-mini" });
});

it("turns permission profiles on with a default profile, and back off", async () => {
  using fixture = setup();
  await using screen = await render(
    <RegistryContext value={fixture.registry}>
      <HubSettings />
    </RegistryContext>,
  );
  const profiles = screen.getByRole("switch", { name: "Permission profiles" });
  const defaultProfile = screen.getByRole("combobox", { name: "Default profile" });
  await expect.element(profiles).not.toBeChecked();
  await expect.element(defaultProfile).toBeDisabled();
  await userEvent.click(profiles);
  await expect.element(profiles).toBeChecked();
  await userEvent.click(defaultProfile);
  await userEvent.click(screen.getByRole("option", { name: "Manager", exact: true }));
  await expect.element(defaultProfile).toHaveTextContent("Manager");
  await userEvent.click(profiles);
  await expect.element(profiles).not.toBeChecked();
  expect(state.update.mock.calls.map((call) => call[1].input.patch)).toEqual([
    { goatclaw: { enabled: true } },
    { goatclaw: { defaultProfile: "manager" } },
    { goatclaw: { enabled: false } },
  ]);
});
