import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  type DesktopSshPreparationProgress,
  type SshHostResult,
} from "@goat/contracts";
import {
  type ConnectionOnboarding,
  SshConnectionProfile,
  SshConnectionTarget,
} from "@goat/client-runtime/connection";
import type { EnvironmentPresentation } from "../../state/environments";
import { TooltipProvider } from "../ui/tooltip";
import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render, stubGlobal } from "../../../test/render";

const state = vi.hoisted(() => ({
  preflightSshHost: vi.fn(),
  probeSshHost: vi.fn(),
  trustSshHost: vi.fn(),
  forgetSshHost: vi.fn(),
  confirm: vi.fn(),
  canWriteSsh: true,
  connectPairing: vi.fn(),
  connectSshEnvironment: vi.fn(),
  retryNow: vi.fn(),
  networkOffline: false,
  sshHosts: null as unknown,
  addHubNode: vi.fn(),
  canAddHubNode: true,
  environments: null as unknown as Atom.Writable<ReadonlyArray<EnvironmentPresentation>>,
  runtimeReply: null as SshHostResult | null,
  runtimeReplies: new Map<string, SshHostResult>(),
  statusReads: 0,
  toast: vi.fn(),
}));

vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  useEnvironments: () => ({ environments: useAtomValue(state.environments) }),
  usePrimaryEnvironment: () => ({
    environmentId: "primary",
    label: "This Mac",
    entry: { target: { _tag: "PrimaryConnectionTarget", httpBaseUrl: "http://localhost:3773" } },
  }),
  useRelayEnvironmentDiscovery: () => ({ environments: new Map() }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../../connection/onboarding", () => ({
  connectPairing: state.connectPairing,
  connectSshEnvironment: state.connectSshEnvironment,
}));
vi.mock("../../connection/catalog", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const { AVAILABLE_CONNECTION_STATE } = await import("@goat/client-runtime/connection");
  const connectionState = Atom.make(AsyncResult.success(AVAILABLE_CONNECTION_STATE));
  const offlineState = Atom.make(
    AsyncResult.success({ ...AVAILABLE_CONNECTION_STATE, network: "offline" as const }),
  );
  return {
    environmentCatalog: {
      remove: vi.fn(),
      register: vi.fn(),
      setEnabled: vi.fn(),
      retryNow: state.retryNow,
      stateAtom: () => (state.networkOffline ? offlineState : connectionState),
    },
  };
});
vi.mock("../../state/server", async (importOriginal) => {
  const { Atom } = await import("effect/reactivity");
  const { DEFAULT_SERVER_SETTINGS } = await import("@goat/contracts");
  const { compileResolvedKeybindingsConfig } = await import("@goat/shared/keybindings");
  return {
    ...(await importOriginal<typeof import("../../state/server")>()),
    primaryServerSettingsAtom: Atom.make(DEFAULT_SERVER_SETTINGS),
    primaryServerKeybindingsAtom: Atom.make(
      compileResolvedKeybindingsConfig([
        { key: "mod+1", command: "thread.jump.1" },
        { key: "mod+2", command: "thread.jump.2" },
      ]),
    ),
    serverEnvironment: {
      addHubNode: Object.assign(state.addHubNode, {
        permissionAtom: () => Atom.make(state.canAddHubNode),
      }),
      preflightSshHost: Object.assign(state.preflightSshHost, {
        permissionAtom: () => Atom.make(state.canWriteSsh),
      }),
      probeSshHost: state.probeSshHost,
      trustSshHost: Object.assign(state.trustSshHost, {
        permissionAtom: () => Atom.make(state.canWriteSsh),
      }),
      forgetSshHost: state.forgetSshHost,
      updateStateAtom: () => Atom.make({ status: "idle" }),
    },
    environmentUpdateStatesAtom: (key: string) =>
      Atom.make(key === "" ? [] : key.split("\n").map(() => ({ status: "idle" }))),
  };
});
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: state.sshHosts,
    isPending: false,
    error: null,
    refresh: () => {},
  }),
}));
vi.mock(import("../../cloud/publicConfig"), async (importOriginal) => ({
  ...(await importOriginal()),
  hasCloudPublicConfig: () => false,
}));
vi.mock("~/confirmDialog", () => ({ requestConfirmDialog: state.confirm }));
vi.mock("../ui/toast", () => ({
  toastManager: { add: state.toast },
  stackedThreadToast: (toast: unknown) => toast,
}));

import { SSH_PREFLIGHT_STEP_ORDER, type SshPreflightReport } from "@goat/contracts";
vi.mock("../../state/sshRuntime", async () => {
  const { createSshRuntimeState } = await import("@goat/client-runtime/state/sshRuntime");
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const { Atom } = await import("effect/reactivity");
  return {
    sshRuntime: createSshRuntimeState(Atom.runtime(Layer.empty), {
      status: (target) =>
        Effect.sync(() => {
          state.statusReads += 1;
          return state.runtimeReplies.get(target.alias) ?? state.runtimeReply!;
        }),
      update: () => Effect.sync(() => state.runtimeReply!),
    }),
  };
});

import { ConnectionEnvironmentsSection } from "./ConnectionEnvironmentsSection";

const getLocalEnvironmentBootstraps = () => [
  { id: "primary", bootstrapToken: "test", httpBaseUrl: "http://localhost:3773" },
];
const target = { alias: "fixture-vps", hostname: "example.invalid", username: null, port: null };
const readyReport: SshPreflightReport = {
  host: target.alias,
  destination: { alias: target.alias, hostname: target.hostname, user: "dev", port: 22 },
  steps: SSH_PREFLIGHT_STEP_ORDER.map((id) => ({ id, state: "passed", summary: "Passed" })),
  ready: true,
};
const uploading: DesktopSshPreparationProgress = {
  operationId: "fixture-add",
  phase: "uploading",
  hostAnswered: true,
  remainingMs: 800000,
};

function setup() {
  vi.clearAllMocks();
  state.addHubNode.mockResolvedValue({ _tag: "Success", value: undefined });
  state.preflightSshHost.mockResolvedValue({ _tag: "Success", value: readyReport });
  state.environments = Atom.make<ReadonlyArray<EnvironmentPresentation>>([]).pipe(Atom.keepAlive);
  state.sshHosts = null;
  state.runtimeReplies.clear();
  state.runtimeReply = {
    kind: "ok",
    status: {
      host: target.alias,
      state: "preparing",
      phase: "checking",
      runtimeVersion: null,
      requestedVersion: "0.4.3",
    },
  };
  const registry = AtomRegistry.make();
  const bridge = stubGlobal("desktopBridge", {
    resolveSshHost: vi.fn(),
    getLocalEnvironmentBootstraps,
  });
  return {
    registry,
    [Symbol.dispose]: () => {
      bridge[Symbol.dispose]();
      registry.dispose();
    },
  };
}

const section = (registry: AtomRegistry.AtomRegistry) => (
  <RegistryContext value={registry}>
    <TooltipProvider delay={0}>
      <ConnectionEnvironmentsSection title="Connections" searchable={false} />
    </TooltipProvider>
  </RegistryContext>
);

/** Holds the connect command open until the test settles it. */
function provisionGate() {
  let enter!: (input: ConnectionOnboarding.SshConnectionInput) => void;
  let finish!: (outcome: unknown) => void;
  const entered = new Promise<ConnectionOnboarding.SshConnectionInput>((resolve) => {
    enter = resolve;
  });
  state.connectSshEnvironment.mockImplementation(
    (input: ConnectionOnboarding.SshConnectionInput) =>
      new Promise((resolve) => {
        finish = resolve;
        enter(input);
      }),
  );
  return { entered, settle: (outcome: unknown) => act(() => finish(outcome)) };
}

function button(name: string, scope: ParentNode = document) {
  const match = [...scope.querySelectorAll("button")].find(
    (element) =>
      element.getAttribute("aria-label") === name || element.textContent?.trim() === name,
  );
  if (!match) throw new Error(`No button named ${name}`);
  return match;
}

function hostInput() {
  return document.querySelector<HTMLInputElement>("#saved-backend-ssh-host")!;
}

async function type(element: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(() => {
    setValue.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Checks and connects a host from the open dialog's SSH tab. */
async function connectFromDialog(dialog: HTMLElement, alias: string) {
  const sshMode = [...dialog.querySelectorAll("button")].find((element) =>
    element.textContent?.startsWith("SSH"),
  )!;
  await act(() => sshMode.click());
  await type(hostInput(), alias);
  await act(() => button("Check", dialog).click());
  await act(() => button("Connect", dialog).click());
}

async function openAddDialog() {
  await act(() => button("Add device").click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error("Add device dialog did not open");
  return dialog;
}

/** Delivers a preparation report the way the desktop bridge does; the registry runs its Effect. */
const report = (
  registry: AtomRegistry.AtomRegistry,
  input: ConnectionOnboarding.SshConnectionInput,
  progress: DesktopSshPreparationProgress,
) => act(() => void registry.get(Atom.make(input.onPreparationProgress!(progress))));

it("closes the dialog on Connect, shows add progress in the list row and drops a superseded add silently", async () => {
  using fixture = setup();
  await using screen = await render(section(fixture.registry));
  const gate = provisionGate();
  await connectFromDialog(await openAddDialog(), target.alias);
  const input = await gate.entered;
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  await report(fixture.registry, input, uploading);
  expect(screen.container.textContent).toContain(
    "Installing GOAT runtime. First setup can take a few minutes",
  );
  expect(screen.container.textContent?.match(/Installing GOAT runtime/g)).toHaveLength(1);
  await report(fixture.registry, input, { ...uploading, phase: null, outcome: "superseded" });
  expect(screen.container.textContent).not.toContain("Installing GOAT");
  await gate.settle({
    _tag: "Failure",
    cause: Cause.fail(new Error("SSH preparation superseded by a newer connection intent.")),
  });
  await vi.waitFor(() => expect(screen.container.textContent).not.toContain(target.alias));
  expect(screen.container.querySelector('[role="alert"]')).toBeNull();
  expect(state.toast).not.toHaveBeenCalled();
  await report(fixture.registry, input, uploading);
  expect(screen.container.textContent).not.toContain("Installing GOAT");
});

it("keeps an add running after the list unmounts and lists its failure until dismissed", async () => {
  using fixture = setup();
  await using screen = await render(section(fixture.registry));
  const gate = provisionGate();
  await connectFromDialog(await openAddDialog(), target.alias);
  const input = await gate.entered;
  await screen.rerender(<div />);
  await report(fixture.registry, input, uploading);
  await gate.settle({ _tag: "Failure", cause: Cause.fail(new Error("late failure")) });
  expect(screen.container.textContent).toBe("");
  expect(state.toast).not.toHaveBeenCalled();
  await screen.rerender(section(fixture.registry));
  await vi.waitFor(() => expect(screen.container.textContent).toContain("late failure"));
  expect(button("Retry", screen.container)).toBeTruthy();
  await act(() => button("Dismiss", screen.container).click());
  expect(screen.container.textContent).not.toContain("late failure");
});

it("retries a failed route add against the same machine and offers fingerprint review only while it is saved", async () => {
  using fixture = setup();
  const environmentId = EnvironmentId.make("fixture-machine");
  const environment: EnvironmentPresentation = {
    environmentId,
    label: "Fixture VPS",
    displayUrl: null,
    relayManaged: false,
    serverConfig: null,
    entry: {
      enabled: true,
      target: new SshConnectionTarget({
        environmentId,
        connectionId: "fixture-ssh",
        label: "Fixture VPS",
      }),
      profile: Option.some(
        new SshConnectionProfile({
          environmentId,
          connectionId: "fixture-ssh",
          label: "Fixture VPS",
          target,
        }),
      ),
    },
    connection: {
      phase: "reconnecting",
      stage: "opening",
      error: "Network unavailable",
      traceId: null,
      failure: { kind: "retrying", reason: "network", detail: "Network unavailable" },
    },
  };
  const route = { alias: "fixture-tail", hostname: "fixture-tail", user: "dev", port: 22 };
  state.preflightSshHost.mockResolvedValue({
    _tag: "Success",
    value: { ...readyReport, host: route.alias, destination: route },
  });
  state.connectSshEnvironment.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(new Error("Host key verification failed.")),
  });
  state.runtimeReplies.set(route.alias, {
    kind: "ok",
    status: {
      host: route.alias,
      state: "untrusted",
      runtimeVersion: null,
      requestedVersion: "0.4.3",
    },
  });
  fixture.registry.set(state.environments, [environment]);
  await using screen = await render(section(fixture.registry));
  await act(() => button("Routes", screen.container).click());
  await act(() => button("Add route", screen.container).click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Add a route to Fixture VPS");
  await connectFromDialog(dialog, route.alias);
  await vi.waitFor(() => expect(screen.container.textContent).toContain("Couldn't add route"));
  await act(() => button("Retry", screen.container).click());
  await vi.waitFor(() => expect(state.connectSshEnvironment).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(screen.container.textContent).toContain("Couldn't add route"));
  expect(
    state.connectSshEnvironment.mock.calls.map(([call]) => call.expectedEnvironmentId),
  ).toEqual([environmentId, environmentId]);

  await act(() => button("Review fingerprint", screen.container).click());
  const review = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(review.textContent).toContain("Add a route to Fixture VPS");
  expect(hostInput().value).toBe(route.alias);
  await act(() => button("Close", review).click());
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());

  await act(() => fixture.registry.set(state.environments, []));
  expect(screen.container.textContent).toContain("Couldn't add route");
  expect(() => button("Review fingerprint", screen.container)).toThrow();
  expect(button("Retry", screen.container)).toBeTruthy();
});

it.each(["preparing", "update_waiting"] as const)(
  "stops reading runtime status once an add fails while the cached status is %s",
  async (cachedState) => {
    using fixture = setup();
    await using screen = await render(section(fixture.registry));
    using _timers = fakeTimers();
    const gate = provisionGate();
    await connectFromDialog(await openAddDialog(), target.alias);
    await gate.entered;
    state.runtimeReply = {
      kind: "ok",
      status: {
        host: target.alias,
        state: cachedState,
        ...(cachedState === "preparing" ? { phase: "uploading" as const } : {}),
        runtimeVersion: null,
        requestedVersion: "0.4.3",
      },
    };
    await gate.settle({ _tag: "Failure", cause: Cause.fail(new Error("Connection reset")) });
    await vi.waitFor(() => expect(screen.container.textContent).toContain("Connection reset"));
    const reads = state.statusReads;
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(state.statusReads).toBe(reads);
    expect(screen.container.textContent).not.toMatch(/Installing GOAT|Uploading GOAT|first setup/i);
    expect(button("Retry", screen.container)).toBeTruthy();
    expect(button("Dismiss", screen.container)).toBeTruthy();
  },
);
