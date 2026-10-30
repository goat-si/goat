import {
  EnvironmentId,
  ProviderInstanceId,
  type HostStatusEntry,
  type HubNode,
  type OpenCodexChildSetup,
} from "@goat/contracts";
import { useSyncExternalStore, act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("@goat/shared/goatConnect", async (original) => ({
  ...(await original<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));

type Target = {
  environmentId: string;
  label: string;
  serverConfig?: {
    settings: {
      hub: { enabled: boolean; autoJoinCloudMachines: boolean; connectDevicesHubProxy?: boolean };
    };
    environment?: { capabilities: { hubProxy?: boolean } };
  };
};
const state = vi.hoisted(() => ({
  revision: 0,
  listeners: new Set<() => void>(),
  environments: [] as Target[],
  selectedTargets: [] as Target[],
  selectedIds: null as Set<string> | null,
  sessionPermissions: null as string[] | null,
  navigate: vi.fn(),
  hosts: [] as HostStatusEntry[],
  hostsError: null as string | null,
  refreshHosts: vi.fn(),
  query: vi.fn(),
  check: vi.fn(),
  remove: vi.fn(),
  dismiss: vi.fn(),
  updateSettings: vi.fn(),
  setOptIn: vi.fn(),
  completeChild: vi.fn(),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: (props: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    accessibilityState?: { checked?: boolean };
  }) => (
    <button
      type="button"
      role={props.accessibilityRole}
      aria-label={props.accessibilityLabel}
      aria-checked={props.accessibilityState?.checked}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/ThemedSwitch", () => ({
  ThemedSwitch: (props: {
    value: boolean;
    disabled?: boolean;
    accessibilityLabel?: string;
    onValueChange: (value: boolean) => void;
  }) => (
    <button
      type="button"
      role="switch"
      aria-label={props.accessibilityLabel}
      aria-checked={props.value}
      disabled={props.disabled}
      onClick={() => props.onValueChange(!props.value)}
    />
  ),
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ui/ScreenScrollView", () => ({
  ScreenScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./components/SettingsScreen", () => ({
  SettingsScreen: ({ children }: { children?: ReactNode }) => <main>{children}</main>,
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
}));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    selectedTargets: state.selectedTargets,
    selectedIds: state.selectedIds,
    availableTargets: state.environments,
  }),
}));
vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  const permissionAtom = () => Atom.make(true);
  return {
    serverEnvironment: {
      hubNodesLive: (target: unknown) => target,
      hostStatus: (target: { environmentId: string }) => ({ hostStatus: target.environmentId }),
      checkHubNodes: Object.assign(state.check, { permissionAtom }),
      removeHubNode: Object.assign(state.remove, { permissionAtom }),
      dismissHubNodeNotice: Object.assign(state.dismiss, { permissionAtom }),
      updateSettings: Object.assign(state.updateSettings, { permissionAtom }),
      setHubDeviceChildOptIn: Object.assign(state.setOptIn, { permissionAtom }),
      setupOpenCodexChild: Object.assign(state.completeChild, { permissionAtom }),
    },
  };
});
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (target: unknown) => {
    useSyncExternalStore(
      (listener) => {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
      () => state.revision,
    );
    return state.query(target);
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../../state/session", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    environmentSession: {
      sessionStateAtom: () =>
        Atom.make(
          state.sessionPermissions === null
            ? AsyncResult.initial(true)
            : AsyncResult.success({
                authenticated: true,
                scopes: [],
                permissions: state.sessionPermissions,
              }),
        ),
    },
  };
});
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: state.navigate }),
}));

import { SettingsHubNodesRouteScreen } from "./SettingsHubNodesRouteScreen";

const first = { environmentId: "hub-a", label: "Home hub" };
const second = { environmentId: "hub-b", label: "Office hub" };
const device: HubNode = {
  nodeId: "lab",
  environmentId: EnvironmentId.make("lab"),
  label: "Lab server",
  kind: "ssh",
  routes: [
    {
      routeId: "ssh:lab",
      source: "registered",
      target: { kind: "ssh", alias: "lab", hostname: null, username: null, port: null },
      status: "unknown",
      checkedAt: null,
      lastSeenAt: null,
      lastError: null,
    },
  ],
  status: "unknown",
  lastSeenAt: null,
  addedBy: null,
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.environments = [first, second];
  state.selectedTargets = [first, second];
  state.selectedIds = null;
  state.sessionPermissions = null;
  state.navigate.mockReset();
  state.hosts = [];
  state.hostsError = null;
  state.refreshHosts.mockReset();
  state.query.mockReset().mockImplementation((target: object) =>
    "hostStatus" in target
      ? state.hostsError === null
        ? {
            data: { hosts: state.hosts },
            error: null,
            cause: null,
            isSuccess: true,
            refresh: state.refreshHosts,
          }
        : { data: null, error: state.hostsError, cause: null, refresh: state.refreshHosts }
      : { data: { nodes: [device], notices: [] }, error: null, cause: null },
  );
  for (const command of [state.check, state.remove, state.dismiss, state.setOptIn])
    command.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  state.completeChild.mockReset().mockResolvedValue({ _tag: "Success", value: { kind: "ok" } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const render = () =>
  act(async () => {
    state.revision++;
    for (const listener of state.listeners) listener();
    root.render(<SettingsHubNodesRouteScreen />);
  });
function button(name: string) {
  const match = container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  if (!match) throw new Error(`Missing button ${name}`);
  return match;
}

it("uses the Settings selected hub for device queries and named row actions", async () => {
  state.selectedIds = new Set([second.environmentId]);
  state.selectedTargets = [second];
  await render();
  expect(container.textContent).toContain("Hub: Office hub");
  expect(state.query).toHaveBeenCalledWith({ environmentId: second.environmentId, input: {} });
  expect(state.query).not.toHaveBeenCalledWith({ environmentId: first.environmentId, input: {} });
  expect(button("Check Lab server").textContent).toBe("Check");
  expect(button("Remove Lab server").textContent).toBe("Remove");
  await act(async () => button("Check Lab server").click());
  expect(state.check).toHaveBeenCalledWith({
    environmentId: second.environmentId,
    input: { nodeId: device.nodeId },
  });
  await act(async () => button("Remove Lab server").click());
  expect(state.remove).toHaveBeenCalledWith({
    environmentId: second.environmentId,
    input: { nodeId: device.nodeId },
  });
});

it("requires an explicit hub choice when several Settings targets apply", async () => {
  await render();
  expect(state.query).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Choose a hub to see its devices.");
  await act(async () => button("Use hub Office hub, connected").click());
  expect(button("Use hub Office hub, connected").getAttribute("aria-checked")).toBe("true");
  expect(state.query).toHaveBeenCalledWith({ environmentId: second.environmentId, input: {} });
  expect(container.textContent).toContain("Hub: Office hub");
});

it("keeps the chosen hub disconnected instead of switching, and resumes it on reconnect", async () => {
  await render();
  await act(async () => button("Use hub Office hub, connected").click());
  state.query.mockClear();
  state.selectedTargets = [first];
  state.environments = [first];
  await render();
  expect(container.textContent).toContain("Office hub is disconnected.");
  expect(state.query).not.toHaveBeenCalled();
  expect(container.querySelector('button[aria-label="Check Lab server"]')).toBeNull();
  state.environments = [first, second];
  state.selectedTargets = [first, second];
  await render();
  expect(state.query).toHaveBeenCalledWith({ environmentId: second.environmentId, input: {} });
  expect(container.textContent).toContain("Hub: Office hub");
});

it("shows the explicitly selected hub as disconnected even on first opening", async () => {
  state.selectedIds = new Set([second.environmentId]);
  state.selectedTargets = [];
  await render();
  expect(container.textContent).toContain("Office hub is disconnected.");
  expect(state.query).not.toHaveBeenCalled();
});

it("honors an explicit Settings selection change", async () => {
  state.selectedIds = new Set([second.environmentId]);
  state.selectedTargets = [second];
  await render();
  state.query.mockClear();
  state.selectedIds = new Set([first.environmentId]);
  state.selectedTargets = [first];
  await render();
  expect(container.textContent).toContain("Hub: Home hub");
  expect(state.query).toHaveBeenCalledWith({ environmentId: first.environmentId, input: {} });
});

it("offers an explicit choice when a hub appears after opening with none", async () => {
  state.environments = [];
  state.selectedTargets = [];
  await render();
  expect(state.query).not.toHaveBeenCalled();
  state.environments = [first];
  state.selectedTargets = [first];
  await render();
  await act(async () => button("Use hub Home hub, connected").click());
  expect(state.query).toHaveBeenCalledWith({ environmentId: first.environmentId, input: {} });
});

it("tells the user when the chosen hub is too old to keep a device list", async () => {
  state.environments = [first];
  state.selectedTargets = [first];
  state.hosts = [
    { host: "boat-9", reachability: "ok", opencodexChild: { state: "running", checkedAt: 0 } },
  ];
  state.query.mockImplementation((target: object) =>
    "hostStatus" in target
      ? {
          data: { hosts: state.hosts },
          error: null,
          cause: null,
          isSuccess: true,
          refresh: state.refreshHosts,
        }
      : { data: null, error: null, cause: new Error("Unknown request tag: hub.nodes.subscribe") },
  );
  await render();
  expect(container.textContent).toContain("This hub runs an older GOAT without a device list.");
  expect(container.querySelector('button[aria-label="Check Lab server"]')).toBeNull();
  // Host status still answers, so the Home's setup of a cloud machine still shows.
  expect(container.textContent).toContain("boat-9");
  expect(container.textContent).toContain("Setting up as OpenCodex Child");
});

it("shows each device's OpenCodex link and why the hub could not make it a Child", async () => {
  state.environments = [first];
  state.selectedTargets = [first];
  state.hosts = [
    {
      host: "lab",
      reachability: "unreachable",
      opencodexChild: {
        state: "blocked",
        reason: "npm_missing",
        message: "npm is not installed on lab.",
        checkedAt: 0,
      },
    },
  ];
  await render();
  expect(container.textContent).toContain("Lab server");
  expect(container.textContent).toContain("Not linked to OpenCodex");
  expect(container.textContent).toContain("OpenCodex Child setup blocked: npm missing");
  expect(container.textContent).toContain("npm is not installed on lab.");
  expect(button("Check Lab server").textContent).toBe("Check");
});

it("says when OpenCodex link state could not be read, keeps the hub's devices, and reads it again", async () => {
  state.environments = [first];
  state.selectedTargets = [first];
  state.hostsError = "Host status timed out.";
  await render();
  expect(container.textContent).toContain(
    "Could not read OpenCodex link state. Host status timed out.",
  );
  expect(container.textContent).toContain("Lab server");
  expect(container.textContent).not.toContain("Not linked to OpenCodex");
  await act(async () => button("Try again").click());
  expect(state.refreshHosts).toHaveBeenCalledOnce();
});

it("rereads host status while a setup is running, and stops once none is", async () => {
  state.environments = [first];
  state.selectedTargets = [first];
  state.hosts = [
    { host: "lab", reachability: "ok", opencodexChild: { state: "running", checkedAt: 0 } },
  ];
  vi.useFakeTimers();
  try {
    await render();
    act(() => vi.advanceTimersByTime(15_000));
    expect(state.refreshHosts).toHaveBeenCalledOnce();
    state.hosts = [
      { host: "lab", reachability: "ok", opencodexChild: { state: "child", checkedAt: 1 } },
    ];
    await render();
    act(() => vi.advanceTimersByTime(60_000));
    expect(state.refreshHosts).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it("switches an SSH host's Child setup and the cloud switch, and warns when an older hub keeps joining", async () => {
  const hub = {
    ...second,
    serverConfig: { settings: { hub: { enabled: true, autoJoinCloudMachines: true } } },
  };
  state.environments = [hub];
  state.selectedTargets = [hub];
  state.hosts = [{ host: "lab", reachability: "ok", opencodexChildOptIn: false }];
  // An older hub drops the field it does not know and answers on.
  state.updateSettings
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { hub: { autoJoinCloudMachines: true } } });
  await render();
  const optIn = button("Join Lab server as OpenCodex Child after each SSH setup");
  expect(optIn.getAttribute("aria-checked")).toBe("false");
  await act(async () => optIn.click());
  expect(state.setOptIn).toHaveBeenCalledWith({
    environmentId: second.environmentId,
    input: { deviceAlias: "lab", enabled: true },
  });
  expect(state.refreshHosts).toHaveBeenCalled();
  const cloud = button("Join new cloud machines");
  expect(cloud.getAttribute("aria-checked")).toBe("true");
  await act(async () => cloud.click());
  expect(state.updateSettings).toHaveBeenCalledWith({
    environmentId: second.environmentId,
    input: { patch: { hub: { autoJoinCloudMachines: false } } },
  });
  expect(container.textContent).toContain("older GOAT that always joins its cloud machines");
});

it("offers neither switch for a hub that does not report them", async () => {
  state.selectedIds = new Set([second.environmentId]);
  state.selectedTargets = [second];
  state.hosts = [{ host: "lab", reachability: "ok" }];
  await render();
  expect(container.querySelector('[role="switch"]')).toBeNull();
});

it("saves account-wide Connect consent on the selected mobile hub and reports an older server", async () => {
  const hub = {
    ...second,
    serverConfig: {
      settings: {
        hub: { enabled: true, autoJoinCloudMachines: true, connectDevicesHubProxy: false },
      },
    },
  };
  state.environments = [hub];
  state.selectedTargets = [hub];
  state.updateSettings.mockReset().mockResolvedValue({ _tag: "Success", value: { hub: {} } });
  await render();
  const consent = button("Allow GOAT Connect devices to reach hub devices");
  expect(consent.getAttribute("aria-checked")).toBe("false");
  await act(async () => consent.click());
  expect(state.updateSettings).toHaveBeenCalledWith({
    environmentId: second.environmentId,
    input: { patch: { hub: { connectDevicesHubProxy: true } } },
  });
  expect(container.textContent).toContain("sign out of GOAT Connect and sign back in");
  expect(container.textContent).toContain("Update GOAT on the hub");
});

function childSetupFixture(overrides: Partial<OpenCodexChildSetup> = {}): OpenCodexChildSetup {
  return {
    version: 1,
    operationId: "setup-1",
    destinationEnvironmentId: EnvironmentId.make("lab"),
    homeEnvironmentId: EnvironmentId.make(first.environmentId),
    instanceId: ProviderInstanceId.make("child-codex"),
    revision: { epoch: "test-epoch", sequence: 1 },
    steps: [],
    readiness: "linked",
    attribution: "home_zero_local_accounts",
    nextAction: "retry",
    ...overrides,
  };
}

it("keeps a linked Child listed as unverified and starts setup only when asked", async () => {
  state.environments = [first];
  state.selectedTargets = [first];
  state.hosts = [
    { host: "lab", reachability: "ok", opencodexChild: { state: "child", checkedAt: 0 } },
  ];
  await render();
  expect(container.textContent).toContain("Linked to OpenCodex");
  expect(container.textContent).toContain("Linked · Codex not verified");
  expect(container.textContent).not.toContain("Ready");
  expect(state.completeChild).not.toHaveBeenCalled();
  await act(async () => button("Continue setup").click());
  expect(state.completeChild).toHaveBeenCalledExactlyOnceWith({
    environmentId: first.environmentId,
    input: { deviceAlias: "lab" },
  });
  expect(state.refreshHosts).toHaveBeenCalled();
});

it("shows the failed step's reason without Ready and offers Continue setup again", async () => {
  state.environments = [first];
  state.selectedTargets = [first];
  state.hosts = [
    {
      host: "lab",
      reachability: "ok",
      opencodexChild: {
        state: "child",
        checkedAt: 0,
        setup: childSetupFixture({
          readiness: "invalid",
          failure: {
            code: "probe_failed",
            step: "inference_verified",
            message: "Home refused the request.",
            retryable: true,
          },
        }),
      },
    },
  ];
  state.completeChild.mockResolvedValueOnce({
    _tag: "Success",
    value: {
      kind: "error",
      failure: {
        code: "probe_failed",
        step: "inference_verified",
        message: "Home is still refusing.",
        retryable: true,
      },
    },
  });
  await render();
  expect(container.textContent).toContain("Home refused the request.");
  expect(container.textContent).not.toContain("Ready");
  await act(async () => button("Continue setup").click());
  expect(container.textContent).toContain("lab: Home is still refusing.");
});

it("keeps reading status while a linked Child verifies, without starting another request", async () => {
  state.environments = [first];
  state.selectedTargets = [first];
  state.hosts = [
    {
      host: "lab",
      reachability: "ok",
      opencodexChild: {
        state: "child",
        checkedAt: 0,
        setup: childSetupFixture({
          readiness: "verifying",
          nextAction: "none",
          steps: [{ step: "inference_verified", state: "running" }],
        }),
      },
    },
  ];
  vi.useFakeTimers();
  try {
    await render();
    expect(container.textContent).toContain("Verify a request through Home…");
    act(() => vi.advanceTimersByTime(15_000));
    expect(state.refreshHosts).toHaveBeenCalledOnce();
    expect(state.completeChild).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("explains why a pairing without hub access shows no hub devices, and opens the scanner to fix it", async () => {
  const hub = {
    ...first,
    serverConfig: {
      settings: { hub: { enabled: true, autoJoinCloudMachines: true } },
      environment: { capabilities: { hubProxy: true } },
    },
  };
  state.environments = [hub];
  state.selectedTargets = [hub];
  state.sessionPermissions = ["orchestration:read"];
  await render();
  expect(container.textContent).toContain("These devices do not open on this phone");
  expect(container.textContent).toContain("Also open hub devices");
  await act(async () => button("Scan new QR").click());
  expect(state.navigate).toHaveBeenCalledWith("SettingsEnvironmentNew", { routeFor: "hub-a" });

  state.sessionPermissions = ["orchestration:read", "hub:proxy"];
  act(() => root.unmount());
  root = createRoot(container);
  await render();
  expect(container.textContent).not.toContain("These devices do not open on this phone");
});
