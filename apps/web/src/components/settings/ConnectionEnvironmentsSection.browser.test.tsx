import * as Cause from "effect/Cause";
import { isMacPlatform } from "@goat/shared/keybindings";
import { it as effectIt } from "@effect/vitest";
import { actEffect, makeSshProvisionGate } from "./sshPreparation.test-support";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  type DesktopSshPreparationProgress,
  type SshHostResult,
} from "@goat/contracts";
import {
  SshConnectionTarget,
  SshConnectionProfile,
  connectionRouteId,
} from "@goat/client-runtime/connection";
import type { EnvironmentPresentation } from "../../state/environments";
import { TooltipProvider } from "../ui/tooltip";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

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
        Effect.sync(() => state.runtimeReplies.get(target.alias) ?? state.runtimeReply!),
      update: () => Effect.sync(() => state.runtimeReply!),
    }),
  };
});

import { ConnectionEnvironmentsSection } from "./ConnectionEnvironmentsSection";

const getLocalEnvironmentBootstraps = () => [
  { id: "primary", bootstrapToken: "test", httpBaseUrl: "http://localhost:3773" },
];

const readyReport: SshPreflightReport = {
  host: "devbox",
  destination: { alias: "devbox", hostname: "devbox.local", user: "dev", port: 22 },
  steps: SSH_PREFLIGHT_STEP_ORDER.map((id) => ({ id, state: "passed", summary: "Passed" })),
  ready: true,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.toast.mockReset();
  state.addHubNode.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  state.canAddHubNode = true;
  state.canWriteSsh = true;
  state.preflightSshHost.mockReset();
  state.probeSshHost.mockReset();
  state.trustSshHost.mockReset();
  state.forgetSshHost.mockReset();
  state.confirm.mockReset();
  state.preflightSshHost.mockResolvedValue({ _tag: "Success", value: readyReport });
  // Fixtures set this before render; keepAlive stops the registry from dropping the unobserved value.
  state.environments = Atom.make<ReadonlyArray<EnvironmentPresentation>>([]).pipe(Atom.keepAlive);
  state.runtimeReply = {
    kind: "ok",
    status: {
      host: "fixture-vps",
      state: "preparing",
      phase: "checking",
      runtimeVersion: null,
      requestedVersion: "0.4.3",
    },
  };
  state.runtimeReplies.clear();
  state.toast.mockReset();
  state.connectPairing.mockReset();
  state.connectSshEnvironment.mockReset();
  state.retryNow.mockReset();
  state.networkOffline = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  state.sshHosts = null;
  delete (window as { desktopBridge?: unknown }).desktopBridge;
});

function button(name: string, scope: ParentNode = document) {
  const match = [...scope.querySelectorAll("button")].find(
    (element) =>
      element.getAttribute("aria-label") === name || element.textContent?.trim() === name,
  );
  if (!match) throw new Error(`No button named ${name}`);
  return match;
}

function input(placeholder: string) {
  const match = document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`);
  if (!match) throw new Error(`No input with placeholder ${placeholder}`);
  return match;
}

function type(element: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setValue.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openAddDialog() {
  await act(async () => {
    root.render(<ConnectionEnvironmentsSection title="Connections" searchable={false} />);
  });
  await act(async () => button("Add device").click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error("Add device dialog did not open");
  return dialog;
}

it("shows the empty state when no machines are saved", async () => {
  await act(async () => {
    root.render(<ConnectionEnvironmentsSection title="Connections" searchable={false} />);
  });
  expect(container.textContent).toContain("Connections");
  expect(container.textContent).toContain("No saved remote environments");
});

it("pairs a pasted GOAT server link through Add device and closes the dialog", async () => {
  state.connectPairing.mockResolvedValue({ _tag: "Success", value: undefined });
  const dialog = await openAddDialog();

  type(input("hub.tailnet-name.ts.net"), "https://hub.tail.ts.net/pair#token=PAIR1234");
  expect(input("PAIRCODE").value).toBe("PAIR1234");

  await act(async () => button("Add device", dialog).click());

  expect(state.connectPairing).toHaveBeenCalledWith({
    host: "https://hub.tail.ts.net",
    pairingCode: "PAIR1234",
  });
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
});

it("keeps the dialog open with the error when pairing fails", async () => {
  state.connectPairing.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(new Error("Pairing code expired")),
  });
  const dialog = await openAddDialog();

  type(input("hub.tailnet-name.ts.net"), "box.example.com");
  type(input("PAIRCODE"), "OLDCODE");
  await act(async () => button("Add device", dialog).click());

  expect(state.connectPairing).toHaveBeenCalledWith({
    host: "box.example.com",
    pairingCode: "OLDCODE",
  });
  const open = document.querySelector('[role="dialog"]');
  expect(open?.textContent).toContain("Pairing code expired");
});

it("keeps thread jump chords inside the SSH host suggestions", async () => {
  state.connectSshEnvironment.mockResolvedValue({ _tag: "Success", value: undefined });
  const resolveSshHost = vi.fn(async () => ({
    alias: "devbox",
    hostname: "devbox.local",
    username: null,
    port: null,
  }));
  (window as { desktopBridge?: unknown }).desktopBridge = {
    resolveSshHost,
    getLocalEnvironmentBootstraps,
  };
  state.sshHosts = [{ alias: "devbox", hostname: "devbox.local", username: null, port: null }];
  const dialog = await openAddDialog();
  const sshMode = [...dialog.querySelectorAll("button")].find((element) =>
    element.textContent?.startsWith("SSH"),
  );
  await act(async () => sshMode!.click());
  const hostInput = document.querySelector<HTMLInputElement>("#saved-backend-ssh-host")!;
  await act(async () => {
    hostInput.focus();
    hostInput.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });

  const chord = (key: string) =>
    new KeyboardEvent("keydown", {
      key,
      code: `Digit${key}`,
      ctrlKey: !isMacPlatform(navigator.platform),
      metaKey: isMacPlatform(navigator.platform),
      bubbles: true,
      cancelable: true,
    });
  // The second jump has no host behind it; it must not reach the thread sidebar's window listener.
  let notCanceled = true;
  act(() => {
    notCanceled = hostInput.dispatchEvent(chord("2"));
  });
  expect(notCanceled).toBe(false);
  expect(resolveSshHost).not.toHaveBeenCalled();

  await act(async () => {
    hostInput.dispatchEvent(chord("1"));
  });
  expect(state.preflightSshHost).toHaveBeenCalledWith({
    environmentId: "primary",
    input: { host: "devbox" },
  });
  expect(state.connectSshEnvironment).not.toHaveBeenCalled();
  await act(async () => button("Connect", dialog).click());
  expect(state.connectSshEnvironment).toHaveBeenCalledWith(
    expect.objectContaining({ target: expect.objectContaining({ alias: "devbox" }) }),
  );
});

it("keeps Add device pending until the GOAT server pairing command settles", async () => {
  let finish!: (result: { _tag: "Success"; value: undefined }) => void;
  state.connectPairing.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const dialog = await openAddDialog();
  type(input("hub.tailnet-name.ts.net"), "https://hub.tail.ts.net/pair#token=PAIR1234");
  await act(async () => button("Add device", dialog).click());
  expect(state.connectPairing).toHaveBeenCalledWith({
    host: "https://hub.tail.ts.net",
    pairingCode: "PAIR1234",
  });
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(button("Adding…", dialog).disabled).toBe(true);
  await act(async () => finish({ _tag: "Success", value: undefined }));
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
});

async function openSshDialog() {
  (window as { desktopBridge?: unknown }).desktopBridge = {
    resolveSshHost: vi.fn(),
    getLocalEnvironmentBootstraps,
  };
  const dialog = await openAddDialog();
  const mode = [...dialog.querySelectorAll("button")].find((element) =>
    element.textContent?.startsWith("SSH"),
  );
  await act(async () => mode!.click());
  return dialog;
}

it("shows failed preflight fixes and only enables Connect after checking again", async () => {
  state.preflightSshHost.mockResolvedValueOnce({
    _tag: "Success",
    value: {
      ...readyReport,
      ready: false,
      steps: readyReport.steps.map((step) =>
        step.id === "key_auth"
          ? {
              ...step,
              state: "failed",
              summary: "Password sign-in required",
              fix: {
                actor: "user",
                instruction: "Install your SSH public key.",
                command: "ssh-copy-id dev@devbox",
              },
            }
          : step,
      ),
    },
  });
  const dialog = await openSshDialog();
  type(input("Search hosts or type devbox"), "devbox");
  await act(async () => button("Check", dialog).click());
  expect(dialog.textContent).toContain("Install your SSH public key.");
  expect(dialog.textContent).toContain("ssh-copy-id dev@devbox");
  expect(button("Connect", dialog).disabled).toBe(true);
  expect(state.probeSshHost).not.toHaveBeenCalled();
  expect(state.connectSshEnvironment).not.toHaveBeenCalled();
  await act(async () => button("Check again", dialog).click());
  expect(button("Connect", dialog).disabled).toBe(false);
});

it("discards a preflight response when the destination changes while checking", async () => {
  let finish!: (result: unknown) => void;
  state.preflightSshHost.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const dialog = await openSshDialog();
  type(input("Search hosts or type devbox"), "devbox");
  await act(async () => button("Check", dialog).click());
  expect(dialog.querySelector('[aria-label="SSH preflight"]')?.getAttribute("aria-busy")).toBe(
    "true",
  );
  type(input("Search hosts or type devbox"), "otherbox");
  await act(async () => finish({ _tag: "Success", value: readyReport }));
  expect(button("Check", dialog).disabled).toBe(false);
  expect(dialog.querySelector('[aria-label="SSH preflight"]')).toBeNull();
  expect(state.connectSshEnvironment).not.toHaveBeenCalled();
});

it("requires settings permission before a check", async () => {
  state.canWriteSsh = false;
  const dialog = await openSshDialog();
  type(input("Search hosts or type devbox"), "devbox");
  expect(button("Check", dialog).disabled).toBe(true);
  expect(state.preflightSshHost).not.toHaveBeenCalled();
});

it("rechecks the alias returned by trust, without connecting on approval", async () => {
  const reviewReport = {
    ...readyReport,
    ready: false,
    destination: { hostname: "devbox.local", user: "dev", port: 2222 },
    steps: readyReport.steps.map((step) =>
      step.id === "host_key" ? { ...step, state: "needs_review" } : step,
    ),
  };
  state.preflightSshHost.mockResolvedValueOnce({ _tag: "Success", value: reviewReport });
  state.probeSshHost.mockResolvedValue({
    _tag: "Success",
    value: {
      probeId: "probe",
      host: "goat-probed",
      human: { location: "Check this host key", fingerprint: "SHA256:test" },
      includeRequired: false,
    },
  });
  state.trustSshHost.mockResolvedValue({
    _tag: "Success",
    value: { kind: "ok", status: { host: "goat-pinned" } },
  });
  state.preflightSshHost.mockResolvedValueOnce({
    _tag: "Success",
    value: {
      ...readyReport,
      host: "goat-pinned",
      destination: { ...readyReport.destination, alias: "goat-pinned" },
    },
  });
  const dialog = await openSshDialog();
  type(input("Search hosts or type devbox"), "dev@devbox.local:2222");
  await act(async () => button("Check", dialog).click());
  expect(state.probeSshHost).toHaveBeenCalledWith({
    environmentId: "primary",
    input: { address: "devbox.local", user: "dev", port: 2222 },
  });
  expect(button("Connect", dialog).disabled).toBe(true);
  await act(async () => button("Approve", dialog).click());
  expect(state.trustSshHost).toHaveBeenCalledWith({
    environmentId: "primary",
    input: { probeId: "probe", accepted: true },
  });
  expect(state.preflightSshHost).toHaveBeenLastCalledWith({
    environmentId: "primary",
    input: { host: "goat-pinned" },
  });
  expect(input("Search hosts or type devbox").value).toBe("goat-pinned");
  expect(state.connectSshEnvironment).not.toHaveBeenCalled();
  expect(button("Connect", dialog).disabled).toBe(false);
});

it.each(["root", "22"])(
  "invalidates ready checks when the %s field changes",
  async (placeholder) => {
    state.preflightSshHost.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        ...readyReport,
        destination: { hostname: "build.example", user: "deploy", port: 22 },
      },
    });
    const dialog = await openSshDialog();
    type(input("Search hosts or type devbox"), "devbox");
    await act(async () => button("Check", dialog).click());
    expect(button("Connect", dialog).disabled).toBe(false);
    type(input(placeholder), placeholder === "22" ? "2222" : "owner");
    expect(button("Check", dialog).disabled).toBe(false);
    expect(dialog.querySelector('[aria-label="SSH preflight"]')).toBeNull();
  },
);

it("shows resolved configured User and Port read-only and sends no overrides on recheck", async () => {
  state.sshHosts = [
    {
      alias: "devbox",
      hostname: "devbox.local",
      username: "ubuntu",
      port: 2222,
      source: "ssh-config",
    },
    {
      alias: "build.example",
      hostname: "build.example",
      username: null,
      port: null,
      source: "known-hosts",
    },
  ];
  state.preflightSshHost.mockResolvedValue({
    _tag: "Success",
    value: {
      ...readyReport,
      destination: { alias: "devbox", hostname: "devbox.local", user: "ubuntu", port: 2222 },
    },
  });
  const dialog = await openSshDialog();
  const host = input("Search hosts or type devbox");
  await act(async () => {
    host.focus();
    host.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  await act(async () =>
    host.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "1",
        code: "Digit1",
        ctrlKey: !isMacPlatform(navigator.platform),
        metaKey: isMacPlatform(navigator.platform),
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(input("root").value).toBe("ubuntu");
  expect(input("22").value).toBe("2222");
  expect(input("root").readOnly).toBe(true);
  expect(input("22").readOnly).toBe(true);
  expect(dialog.textContent).toContain("From ~/.ssh/config");
  await act(async () => button("Check again", dialog).click());
  expect(state.preflightSshHost.mock.calls.map(([call]) => call.input)).toEqual([
    { host: "devbox" },
    { host: "devbox" },
  ]);
  expect(input("root").value).toBe("ubuntu");
  type(host, "build.example");
  expect(input("root").readOnly).toBe(false);
  expect(input("22").readOnly).toBe(false);
  expect(input("root").value).toBe("");
  expect(input("22").value).toBe("");
  type(input("root"), "deploy");
  type(input("22"), "2200");
  await act(async () => button("Check", dialog).click());
  expect(state.preflightSshHost).toHaveBeenLastCalledWith({
    environmentId: "primary",
    input: { host: "build.example", user: "deploy", port: 2200 },
  });
});
it("keeps checking the managed alias a typed address with its own user and port resolved to", async () => {
  state.preflightSshHost.mockResolvedValue({
    _tag: "Success",
    value: {
      ...readyReport,
      destination: {
        alias: "goat-build-1a2b3c4d",
        hostname: "build.example",
        user: "deploy",
        port: 2222,
      },
    },
  });
  const dialog = await openSshDialog();
  type(input("Search hosts or type devbox"), "build.example");
  type(input("root"), "deploy");
  type(input("22"), "2222");
  await act(async () => button("Check", dialog).click());
  expect(input("Search hosts or type devbox").value).toBe("goat-build-1a2b3c4d");
  expect(input("root").value).toBe("deploy");
  expect(input("22").value).toBe("2222");
  await act(async () => button("Check again", dialog).click());
  expect(state.preflightSshHost.mock.calls.map(([call]) => call.input)).toEqual([
    { host: "build.example", user: "deploy", port: 2222 },
    { host: "goat-build-1a2b3c4d" },
  ]);
});

it("offers Forget host for a pinned alias whose checks failed before it was saved", async () => {
  const failed = {
    ...readyReport,
    host: "goat-box-1a2b3c4d",
    ready: false,
    destination: {
      alias: "goat-box-1a2b3c4d",
      managed: true,
      hostname: "box.example",
      user: "jun",
      port: 22,
    },
    steps: readyReport.steps.map((step) =>
      step.id === "key_auth" ? { ...step, state: "failed", summary: "Key refused" } : step,
    ),
  } satisfies SshPreflightReport;
  state.preflightSshHost.mockResolvedValue({ _tag: "Success", value: failed });
  state.confirm.mockResolvedValue(true);
  state.forgetSshHost.mockResolvedValue({
    _tag: "Success",
    value: {
      kind: "ok",
      status: {
        host: "goat-box-1a2b3c4d",
        state: "untrusted",
        runtimeVersion: null,
        requestedVersion: "0.1.0",
      },
    },
  });
  const dialog = await openSshDialog();
  type(input("Search hosts or type devbox"), "goat-box-1a2b3c4d");
  await act(async () => button("Check", dialog).click());
  await act(async () => button("Forget host", dialog).click());
  expect(state.confirm).toHaveBeenCalledOnce();
  expect(state.forgetSshHost).toHaveBeenCalledWith({
    environmentId: "primary",
    input: { host: "goat-box-1a2b3c4d", stopRuntime: "no" },
  });
  expect(input("Search hosts or type devbox").value).toBe("");
  expect(dialog.querySelector('[aria-label="SSH preflight"]')).toBeNull();
});

it("does not offer Forget host for a personal ~/.ssh/config alias", async () => {
  const dialog = await openSshDialog();
  type(input("Search hosts or type devbox"), "devbox");
  await act(async () => button("Check", dialog).click());
  expect([...dialog.querySelectorAll("button")].some((b) => b.textContent === "Forget host")).toBe(
    false,
  );
});

async function saveSshDevice() {
  state.connectSshEnvironment.mockResolvedValue({ _tag: "Success", value: undefined });
  const dialog = await openSshDialog();
  type(input("Search hosts or type devbox"), "devbox");
  await act(async () => button("Check", dialog).click());
  await act(async () => button("Connect", dialog).click());
}

it("keeps a locally saved SSH device and offers Retry after a real hub failure", async () => {
  state.addHubNode.mockResolvedValueOnce({
    _tag: "Failure",
    cause: Cause.fail(new Error("Storage unavailable")),
  });
  await saveSshDevice();
  expect(state.connectSshEnvironment).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
  const toast = state.toast.mock.calls
    .map(([value]) => value)
    .find((value) => value.type === "error");
  expect(toast).toMatchObject({
    title: "Device saved on this desktop, but couldn't be added to the hub",
    actionProps: { children: "Retry" },
  });
  await act(async () => toast.actionProps.onClick());
  expect(state.addHubNode).toHaveBeenCalledTimes(2);
  expect(state.connectSshEnvironment).toHaveBeenCalledOnce();
});

it("silently skips unsupported hub registration after saving SSH locally", async () => {
  state.addHubNode.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.die("Unknown request tag: hub.nodes.add"),
  });
  await saveSshDevice();
  expect(state.addHubNode).toHaveBeenCalledOnce();
  expect(state.connectSshEnvironment).toHaveBeenCalledOnce();
  expect(state.toast.mock.calls.map(([value]) => value.type)).toEqual(["success"]);
});

it("does not register a locally saved SSH device without hub write permission", async () => {
  state.canAddHubNode = false;
  await saveSshDevice();
  expect(state.connectSshEnvironment).toHaveBeenCalledOnce();
  expect(state.addHubNode).not.toHaveBeenCalled();
  expect(state.toast.mock.calls.map(([value]) => value.type)).toEqual(["success"]);
});
effectIt.effect(
  "shows local add progress until terminal and drops a neutral result without a banner or toast",
  () =>
    Effect.gen(function* () {
      const gate = makeSshProvisionGate();
      yield* Effect.forkChild(gate.worker);
      state.connectSshEnvironment.mockImplementation(gate.command);
      const phase: DesktopSshPreparationProgress = {
        operationId: "fixture-add",
        phase: "uploading",
        hostAnswered: true,
        remainingMs: 800000,
      };
      const target = {
        alias: "fixture-vps",
        hostname: "example.invalid",
        username: null,
        port: null,
      };
      (window as { desktopBridge?: unknown }).desktopBridge = {
        resolveSshHost: async () => target,
        getLocalEnvironmentBootstraps,
      };
      state.sshHosts = [target];
      const dialog = yield* Effect.promise(openAddDialog);
      yield* Effect.promise(async () => {
        const sshMode = [...dialog.querySelectorAll("button")].find((element) =>
          element.textContent?.startsWith("SSH"),
        )!;
        await act(async () => sshMode.click());
        type(document.querySelector<HTMLInputElement>("#saved-backend-ssh-host")!, target.alias);
        await act(async () => button("Check", dialog).click());
        await act(async () => button("Connect", dialog).click());
      });
      const input = yield* Deferred.await(gate.entered);
      const report = input.onPreparationProgress!;
      yield* actEffect(report(phase));
      expect(dialog.textContent).toContain(
        "Installing GOAT runtime — first setup can take a few minutes",
      );
      expect(dialog.textContent?.match(/Installing GOAT runtime/g)).toHaveLength(1);
      yield* actEffect(report({ ...phase, phase: null, outcome: "superseded" }));
      expect(dialog.textContent).not.toContain("Installing GOAT");
      yield* actEffect(
        Deferred.succeed(gate.release, {
          _tag: "Failure",
          cause: Cause.fail(new Error("SSH preparation superseded by a newer connection intent.")),
        }),
      );
      expect(dialog.querySelector('[role="alert"]')).toBeNull();
      expect(state.toast).not.toHaveBeenCalled();
      yield* actEffect(report(phase));
      expect(dialog.textContent).not.toContain("Installing GOAT");
      yield* Effect.promise(() =>
        act(async () =>
          dialog.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Escape",
              code: "Escape",
              bubbles: true,
              cancelable: true,
            }),
          ),
        ),
      );
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull()),
      );
      yield* actEffect(report(phase));
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    }),
);

it.each([
  { source: "local", firstState: "preparing" },
  { source: "owner", firstState: "preparing" },
  { source: "alternate", firstState: "failed" },
  { source: "alternate", firstState: "stopped" },
] as const)(
  "updates an open tooltip and subtitle from $source progress with first-route $firstState",
  async ({ source, firstState }) => {
    const registry = AtomRegistry.make();
    const environmentId = EnvironmentId.make("fixture-vps");
    const target = {
      alias: "fixture-vps",
      hostname: "example.invalid",
      username: null,
      port: null,
    };
    const sshTarget = new SshConnectionTarget({
      environmentId,
      connectionId: "fixture-ssh",
      label: "Fixture VPS",
    });
    const alternateTarget = new SshConnectionTarget({
      ...sshTarget,
      connectionId: "fixture-ssh-alternate",
    });
    const alternateSshTarget = {
      ...target,
      alias: "fixture-vps-alternate",
      hostname: "alternate.example.invalid",
    };
    const activeTarget = source === "alternate" ? alternateSshTarget : target;
    const routeId = connectionRouteId(source === "alternate" ? alternateTarget : sshTarget);
    const identity = { supervisorId: "fixture-window", attemptId: 2, routeId };
    const ready = {
      host: activeTarget.alias,
      state: "ready" as const,
      runtimeVersion: "0.4.3",
      requestedVersion: "0.4.3",
    };
    if (source === "owner") {
      state.runtimeReply = {
        kind: "ok",
        status: { ...ready, state: "preparing", phase: "uploading" },
      };
    }
    if (source === "alternate") {
      state.runtimeReplies.set(target.alias, {
        kind: "ok",
        status: { ...ready, host: target.alias, state: "preparing", phase: "checking" },
      });
      state.runtimeReplies.set(alternateSshTarget.alias, { kind: "ok", status: ready });
    }
    const environment: EnvironmentPresentation = {
      environmentId,
      label: "Fixture VPS",
      displayUrl: null,
      relayManaged: false,
      serverConfig: null,
      entry: {
        enabled: true,
        target: sshTarget,
        profile: Option.some(
          new SshConnectionProfile({
            environmentId,
            connectionId: "fixture-ssh",
            label: "Fixture VPS",
            target,
          }),
        ),
        ...(source === "alternate"
          ? {
              alternateRoutes: [
                {
                  target: alternateTarget,
                  profile: Option.some(
                    new SshConnectionProfile({
                      environmentId,
                      connectionId: alternateTarget.connectionId,
                      label: "Fixture VPS alternate",
                      target: alternateSshTarget,
                    }),
                  ),
                },
              ],
            }
          : {}),
      },
      connection: {
        phase: "reconnecting",
        stage: "preparing",
        error: "old setup timeout",
        traceId: null,
        failure: { kind: "retrying", reason: "timeout", detail: "old setup timeout" },
        failureOrigin: { ...identity, attemptId: 1, stage: "preparing", setupTimeout: true },
        ...(source !== "owner"
          ? {
              sshPreparation: {
                ...identity,
                operationId: "fixture-op",
                phase: "uploading" as const,
                hostAnswered: true,
              },
            }
          : {}),
      },
    };
    (window as { desktopBridge?: unknown }).desktopBridge = {};
    registry.set(state.environments, [environment]);
    const { sshRuntime } = await import("../../state/sshRuntime");
    await act(async () =>
      root.render(
        <RegistryContext value={registry}>
          <TooltipProvider delay={0}>
            <ConnectionEnvironmentsSection title="Connections" searchable={false} />
          </TooltipProvider>
        </RegistryContext>,
      ),
    );
    const trigger = [
      ...container.querySelectorAll<HTMLElement>('[data-slot="tooltip-trigger"]'),
    ].find((node) => node.textContent?.includes("Installing GOAT"));
    expect(trigger).toBeDefined();
    expect(container.textContent?.match(/Installing GOAT runtime/g)).toHaveLength(1);
    await act(async () => {
      const pointer = new MouseEvent("pointerover", { bubbles: true });
      Object.defineProperty(pointer, "pointerType", { value: "mouse" });
      trigger!.dispatchEvent(pointer);
      trigger!.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      trigger!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      trigger!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(
      "Installing GOAT runtime",
    );
    const { sshPreparation: _preparation, ...terminalConnection } = environment.connection;
    const readyConnection = {
      ...terminalConnection,
      stage: "opening" as const,
      sshRuntimeReady: {
        ...identity,
        operationId: "fixture-op",
        attachmentId: "fixture-attachment",
        runtimeStatus: ready,
      },
    };
    await act(async () => {
      if (source === "alternate") {
        state.runtimeReplies.set(target.alias, {
          kind: "ok",
          status: { ...ready, host: target.alias, state: firstState },
        });
        await sshRuntime.refresh.run(registry, { environmentId, target });
        await sshRuntime.refresh.run(registry, { environmentId, target: alternateSshTarget });
      }
      registry.set(state.environments, [
        {
          ...environment,
          connection: readyConnection,
        },
      ]);
    });
    expect(trigger?.textContent).toContain("Runtime ready · Opening connection");
    expect(trigger?.className).not.toContain("text-destructive");
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(
      "Runtime ready · Opening connection",
    );
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).not.toMatch(
      /old setup timeout|unknown/,
    );
    if (source === "alternate") {
      state.runtimeReplies.set(alternateSshTarget.alias, {
        kind: "ok",
        status: { ...ready, state: "failed", detail: "Alternate runtime stopped responding" },
      });
      await act(async () => {
        await sshRuntime.refresh.run(registry, { environmentId, target: alternateSshTarget });
      });
      expect(trigger?.textContent).toContain("Reconnecting: old setup timeout");
      expect(trigger?.className).toContain("text-destructive");
      expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(
        "Alternate runtime stopped responding",
      );
      await act(async () =>
        registry.set(state.environments, [
          {
            ...environment,
            connection: {
              ...readyConnection,
              error: "fresh active route timeout",
              failure: {
                kind: "retrying",
                reason: "timeout",
                detail: "fresh active route timeout",
              },
              failureOrigin: { ...identity, attemptId: 3, stage: "opening", setupTimeout: false },
            },
          },
        ]),
      );
      expect(trigger?.textContent).toContain("Reconnecting: fresh active route timeout");
      expect(trigger?.className).toContain("text-destructive");
      expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(
        "fresh active route timeout",
      );
    }
    await act(async () => root.render(<div />));
    registry.dispose();
  },
);

effectIt.effect("ignores local Add reports and a failed completion after unmount", () =>
  Effect.gen(function* () {
    const gate = makeSshProvisionGate();
    yield* Effect.forkChild(gate.worker);
    state.connectSshEnvironment.mockImplementation(gate.command);
    const target = {
      alias: "fixture-vps",
      hostname: "example.invalid",
      username: null,
      port: null,
    };
    (window as { desktopBridge?: unknown }).desktopBridge = {
      resolveSshHost: async () => target,
      getLocalEnvironmentBootstraps,
    };
    state.sshHosts = [target];
    const dialog = yield* Effect.promise(openAddDialog);
    yield* Effect.promise(async () => {
      const sshMode = [...dialog.querySelectorAll("button")].find((element) =>
        element.textContent?.startsWith("SSH"),
      )!;
      await act(async () => sshMode.click());
      type(document.querySelector<HTMLInputElement>("#saved-backend-ssh-host")!, target.alias);
      await act(async () => button("Check", dialog).click());
      await act(async () => button("Connect", dialog).click());
    });
    const input = yield* Deferred.await(gate.entered);
    yield* Effect.promise(() => act(async () => root.render(<div />)));
    yield* input.onPreparationProgress!({
      operationId: "late-add",
      phase: "uploading",
      hostAnswered: true,
      remainingMs: 800000,
    });
    yield* Deferred.succeed(gate.release, {
      _tag: "Failure",
      cause: Cause.fail(new Error("late failure")),
    });
    expect(container.textContent).toBe("");
    expect(state.toast).not.toHaveBeenCalled();
  }),
);

it("expands a saved machine's connection diagnosis and retries without hiding SSH controls", async () => {
  state.networkOffline = true;
  const environmentId = EnvironmentId.make("diagnosis-vps");
  const environment: EnvironmentPresentation = {
    environmentId,
    label: "Diagnosis VPS",
    displayUrl: null,
    relayManaged: false,
    serverConfig: null,
    entry: {
      enabled: true,
      target: new SshConnectionTarget({
        environmentId,
        connectionId: "diagnosis-ssh",
        label: "Diagnosis VPS",
      }),
      profile: Option.some(
        new SshConnectionProfile({
          environmentId,
          connectionId: "diagnosis-ssh",
          label: "Diagnosis VPS",
          target: {
            alias: "diagnosis-vps",
            hostname: "example.invalid",
            username: null,
            port: null,
          },
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
  const registry = AtomRegistry.make();
  try {
    registry.set(state.environments, [environment]);
    await act(async () =>
      root.render(
        <RegistryContext value={registry}>
          <TooltipProvider delay={0}>
            <ConnectionEnvironmentsSection title="Connections" searchable={false} />
          </TooltipProvider>
        </RegistryContext>,
      ),
    );
    expect(container.textContent).toContain("This device is offline");
    expect(container.textContent).not.toContain("Reconnecting: Network unavailable");
    expect(container.querySelector('[aria-label="Switch off Diagnosis VPS"]')).not.toBeNull();
    expect(container.textContent).not.toContain("What to try");
    await act(async () => button("Details").click());
    expect(container.textContent).toContain("What to try");
    await act(async () => button("Retry now").click());
    expect(state.retryNow).toHaveBeenCalledWith(environmentId);
    await act(async () => button("Details").click());
    expect(container.textContent).not.toContain("What to try");
  } finally {
    await act(async () => root.render(<div />));
    registry.dispose();
  }
});
