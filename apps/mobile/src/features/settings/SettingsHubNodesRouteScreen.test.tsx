import { EnvironmentId, type HostStatusEntry, type HubNode } from "@goat/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type Target = { environmentId: string; label: string };
const state = vi.hoisted(() => ({
  environments: [] as Target[],
  selectedTargets: [] as Target[],
  selectedIds: null as Set<string> | null,
  hosts: [] as HostStatusEntry[],
  query: vi.fn(),
  check: vi.fn(),
  remove: vi.fn(),
  dismiss: vi.fn(),
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
    },
  };
});
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (target: unknown) => state.query(target),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));

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
  state.hosts = [];
  state.query
    .mockReset()
    .mockImplementation((target: object) =>
      "hostStatus" in target
        ? { data: { hosts: state.hosts }, error: null, cause: null, isSuccess: true }
        : { data: { nodes: [device], notices: [] }, error: null, cause: null },
    );
  for (const command of [state.check, state.remove, state.dismiss])
    command.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const render = () => act(async () => root.render(<SettingsHubNodesRouteScreen />));
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
      ? { data: { hosts: state.hosts }, error: null, cause: null, isSuccess: true }
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
