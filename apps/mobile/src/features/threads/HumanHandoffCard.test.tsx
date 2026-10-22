import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ThreadId,
  TurnItemId,
  ProviderInstanceId,
  type Handoff,
  type SshHandoffProgressResult,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { AtomRegistry, type AsyncResult as AtomAsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  open: vi.fn(),
  respond: vi.fn(),
  refresh: vi.fn(),
  refreshProviders: vi.fn(),
  navigate: vi.fn(),
  scopeAllowed: true,
  manage: (_registry: AtomRegistry.AtomRegistry, _allowed: boolean) => {},
  publish: (_registry: AtomRegistry.AtomRegistry, _value: SshHandoffProgressResult) => {},
}));
vi.mock("../../state/server", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const canManage = Atom.make(true);
  harness.manage = (registry, value) => {
    harness.scopeAllowed = value;
    registry.set(canManage, value);
  };
  const progress = Atom.make<AtomAsyncResult.AsyncResult<SshHandoffProgressResult, never>>(
    AsyncResult.initial(),
  );
  harness.publish = (registry, value) => registry.set(progress, AsyncResult.success(value));
  return {
    serverEnvironment: Object.fromEntries(
      [
        "openHandoff",
        "respondHandoff",
        "trustSshHost",
        "prepareSshHost",
        "mutateProviderInstance",
        "refreshProviders",
      ].map((label) => [
        label,
        { label, permissionAtom: () => (label === "mutateProviderInstance" ? canManage : allowed) },
      ]),
    ),
    sshHost: { handoffProgress: () => progress, refreshHandoffProgress: harness.refresh },
  };
});
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => harness.scopeAllowed }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) =>
    command.label === "openHandoff"
      ? harness.open
      : command.label === "refreshProviders"
        ? harness.refreshProviders
        : harness.respond,
}));
vi.mock("./CopyTextButton", () => ({
  CopyTextButton: ({ accessibilityLabel }: { accessibilityLabel: string }) => (
    <button>{accessibilityLabel}</button>
  ),
}));
vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => true,
  useNavigation: () => ({ navigate: harness.navigate }),
}));
vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Linking: { openURL: vi.fn(async (_url: string) => {}) },
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({
    children,
    accessibilityRole,
  }: {
    children: ReactNode;
    accessibilityRole?: "alert";
  }) => <span role={accessibilityRole}>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
import { HumanHandoffCard } from "./HumanHandoffCard";

const environmentId = EnvironmentId.make("origin");
const handoff: Handoff = {
  handoffId: TurnItemId.make("handoff"),
  kind: "approval",
  title: "Update GOAT",
  reason: "Approve the runtime update.",
  requestedBy: {
    threadId: ThreadId.make("thread"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    path: "agent",
  },
  target: { environmentId, path: "ssh.runtime_update" },
  dedupeKey: "ssh",
  state: "completed",
  expiresAt: null,
  createdAt: DateTime.makeUnsafe(0),
  actor: { type: "server" },
};
const runtime = { host: "vps-1", runtimeVersion: "0.4.2", requestedVersion: "0.4.2" };
const diagnosis: SshHandoffProgressResult = {
  kind: "available",
  host: "vps-1",
  operationId: "operation",
  generation: 2,
  result: {
    kind: "ok",
    status: {
      ...runtime,
      state: "ready",
      setup: { operationId: "operation", generation: 2, stage: "diagnosis" },
    },
  },
};
let registry: AtomRegistry.AtomRegistry;
let root: Root;
let container: HTMLDivElement;
let mounted: boolean;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mounted = true;
  harness.open.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { human: { location: "Review vps-1 as ops", fingerprint: "SHA256:test-host-key" } },
  });
  harness.respond.mockReset().mockResolvedValue({ _tag: "Success", value: handoff });
  harness.scopeAllowed = true;
  harness.refresh.mockReset();
  harness.navigate.mockReset();
  harness.refreshProviders.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
});
afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  registry.dispose();
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const render = async (record: Handoff = handoff) => {
  await act(async () =>
    root.render(
      <RegistryContext value={registry}>
        <HumanHandoffCard environmentId={environmentId} handoff={record} inherited={false} />
      </RegistryContext>,
    ),
  );
};
const publish = async (value: SshHandoffProgressResult) => {
  await act(async () => harness.publish(registry, value));
};
const click = async (label: string) => {
  const button = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === label,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
};
describe("native SSH human handoff", () => {
  it("opens private fingerprints on review and uses Update now / Cancel for runtime approval", async () => {
    await render({ ...handoff, state: "pending" });
    expect(container.textContent).not.toContain("SHA256:");
    await click("Review request");
    expect(container.textContent).toContain("SHA256:test-host-key");
    expect(container.textContent).toContain("Update now");
    expect(container.textContent).not.toContain("Decline");
    await click("Update now");
    expect(harness.respond).toHaveBeenCalledWith({
      environmentId,
      input: {
        threadId: handoff.requestedBy.threadId,
        handoffId: handoff.handoffId,
        action: "completed",
      },
    });
    expect(container.textContent).not.toContain("is ready for agents");
  });
  it("preserves Decline for a host trust approval", async () => {
    await render({
      ...handoff,
      state: "pending",
      target: { ...handoff.target, path: "ssh.host_add" },
    });
    await click("Review request");
    await click("Decline");
    expect(harness.respond.mock.lastCall?.[0].input.action).toBe("declined");
  });
  it("restores acknowledged cards without human instructions, polls diagnosis, and cleans up", async () => {
    await render();
    expect(harness.refresh).toHaveBeenCalledWith(registry, {
      environmentId,
      input: { threadId: handoff.requestedBy.threadId, handoffId: handoff.handoffId },
      targetPath: handoff.target.path,
    });
    expect(harness.open).not.toHaveBeenCalled();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await publish(diagnosis);
    expect(container.textContent).toContain("Approved · GOAT is updating vps-1");
    expect(container.textContent).toContain("Checking providers");
    expect(container.textContent).not.toContain("is ready for agents");
    const before = harness.refresh.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(harness.refresh.mock.calls.length).toBe(before + 1);
    await publish({
      ...diagnosis,
      kind: "available",
      host: "vps-1",
      operationId: "operation",
      generation: 2,
      result: {
        kind: "ok",
        status: {
          ...runtime,
          state: "providers_not_ready",
          setup: { operationId: "operation", generation: 2, stage: "complete" },
          providers: {
            ready: false,
            checkedAt: "2026-10-18T00:00:00.000Z",
            fixes: [{ actor: "human", instruction: "Sign in to your provider on vps-1." }],
          },
        },
      },
    });
    expect(container.textContent).toContain("Providers need attention");
    expect(container.textContent).toContain("Sign in to your provider on vps-1.");
    const finalCalls = harness.refresh.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(harness.refresh).toHaveBeenCalledTimes(finalCalls);
    await act(async () => root.unmount());
    mounted = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(harness.refresh).toHaveBeenCalledTimes(finalCalls);
  });
});

it("shows the environment guidance only after the current operation completes", async () => {
  await render();
  await publish(diagnosis);
  expect(container.textContent).not.toContain("is ready for agents");
  await publish({
    kind: "available",
    host: "vps-1",
    operationId: "operation",
    generation: 2,
    result: {
      kind: "ok",
      status: {
        ...runtime,
        state: "ready",
        setup: { operationId: "operation", generation: 2, stage: "complete" },
      },
    },
  });
  await render({ ...handoff });
  expect(container.textContent?.match(/is ready for agents on this environment/g)).toHaveLength(1);
});
it("refreshes waiting hosts every ten seconds", async () => {
  await render();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await publish({
    kind: "available",
    host: "vps-1",
    operationId: "operation",
    generation: 2,
    result: {
      kind: "ok",
      status: {
        ...runtime,
        state: "update_waiting",
        waitingReason: "busy",
        setup: { operationId: "operation", generation: 2, stage: "runtime" },
      },
    },
  });
  const before = harness.refresh.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9_999);
  });
  expect(harness.refresh).toHaveBeenCalledTimes(before);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(harness.refresh).toHaveBeenCalledTimes(before + 1);
});

it.each([
  { path: "ssh.host_add", kind: "approval", approveLabel: "Approve" },
  { path: "ssh.host_prepare", kind: "terminal", approveLabel: "I've added the key" },
] as const)(
  "keeps one way to finish $path, before and after review",
  async ({ path, kind, approveLabel }) => {
    harness.open.mockResolvedValue({
      _tag: "Success",
      value: {
        human: {
          location:
            "vps-1 presented this key as ops. GOAT will add one Include line to ~/.ssh/config.",
          fingerprint: "SHA256:test-host-key",
          command: "ssh-copy-id ops@vps-1",
        },
      },
    });
    const expiresAt = DateTime.makeUnsafe("2026-10-18T12:00:00Z");
    await render({
      ...handoff,
      kind,
      state: "pending",
      expiresAt,
      target: { ...handoff.target, path },
    });
    expect(container.textContent).toContain(
      `Expires ${DateTime.toDate(expiresAt).toLocaleTimeString()}`,
    );
    expect(container.textContent).not.toContain(`${kind.replaceAll("_", " ")} · pending`);
    expect(container.textContent).not.toContain("Cancel request");
    expect(harness.refresh).not.toHaveBeenCalled();
    await click("Review request");
    expect(container.textContent).not.toContain("Where:");
    expect(container.textContent).not.toContain("Cancel request");
    expect(container.textContent).toContain(
      "If your server provider shows a host key, check that it matches.",
    );
    expect(container.textContent).toContain(
      "Run this in your own terminal on the computer that runs GOAT. If the server asks for a password, enter it there; GOAT never sees it.",
    );
    expect(container.textContent).toContain("Only you see these details. The agent never does.");
    expect(container.textContent?.match(/Include line/g)).toHaveLength(1);
    await click(approveLabel);
    expect(harness.respond).toHaveBeenCalledWith({
      environmentId,
      input: {
        threadId: handoff.requestedBy.threadId,
        handoffId: handoff.handoffId,
        action: "completed",
      },
    });
    expect(harness.refresh).not.toHaveBeenCalled();
  },
);
it.each([
  { state: "completed", label: "Approved" },
  { state: "declined", label: "Declined" },
  { state: "cancelled", label: "Cancelled" },
  { state: "expired", label: "Expired" },
] as const)(
  "names a resolved $state SSH request without its internal state",
  async ({ state, label }) => {
    await render({ ...handoff, state, resolvedBy: "Jun" });
    expect(container.textContent).toContain(`${label} by Jun`);
    expect(container.textContent).not.toContain(`approval · ${state}`);
    expect(container.textContent).not.toContain("Expires");
    if (state !== "completed") expect(harness.refresh).not.toHaveBeenCalled();
  },
);
it.each([
  {
    path: "ssh.runtime_update",
    message: "This approval expired before GOAT could update vps-1. Ask again.",
  },
  {
    path: "ssh.host_add",
    message: "This approval expired before GOAT could set up vps-1. Ask the agent again.",
  },
])("explains what an expired $path approval did not start", async ({ path, message }) => {
  await render({
    ...handoff,
    resolvedAt: DateTime.makeUnsafe(0),
    target: { ...handoff.target, path },
  });
  await publish({
    kind: "available",
    host: "vps-1",
    operationId: "operation",
    generation: 2,
    result: {
      kind: "ok",
      status: {
        ...runtime,
        state: "trust_pending",
        setup: { operationId: "operation", generation: 2, stage: "runtime" },
      },
    },
  });
  expect(container.textContent).toContain(message);
  expect(container.textContent).not.toContain("GOAT is setting up");
  expect(container.textContent).not.toContain("GOAT is updating");
});
it("preserves the generic terminal completion and cancellation actions", async () => {
  await render({
    ...handoff,
    kind: "terminal",
    state: "pending",
    target: { ...handoff.target, path: "provider.sign_in" },
  });
  await click("Review request");
  expect(container.textContent).toContain("I've completed this step");
  await click("Cancel request");
  expect(harness.respond.mock.lastCall?.[0].input.action).toBe("cancelled");
  expect(harness.refresh).not.toHaveBeenCalled();
});

it.each([
  {
    path: "ssh.runtime_update",
    kind: "approval",
    message: "This approval expired before GOAT could update vps-1. Ask again.",
  },
  {
    path: "ssh.host_add",
    kind: "approval",
    message: "This approval expired before GOAT could set up vps-1. Ask the agent again.",
  },
  {
    path: "ssh.host_prepare",
    kind: "terminal",
    message: "This approval expired before GOAT could set up vps-1. Ask the agent again.",
  },
] as const)(
  "uses the action-specific expiry copy for the server's $path failure",
  async ({ path, kind, message }) => {
    await render({ ...handoff, kind, target: { ...handoff.target, path } });
    await publish({
      kind: "available",
      host: "vps-1",
      operationId: "operation",
      generation: 2,
      result: {
        kind: "ok",
        status: {
          ...runtime,
          state: "failed",
          setup: { operationId: "operation", generation: 2, stage: "complete" },
          detail: "This approval expired.",
          failure: {
            reason: "approval_expired",
            fix: { actor: "human", instruction: "Ask the agent again." },
          },
        },
      },
    });
    expect(container.textContent).toContain(message);
    expect(container.textContent).not.toContain("This approval expired.");
  },
);

describe("provider setup request", () => {
  const request: Handoff = {
    ...handoff,
    kind: "approval",
    title: "Set up Claude",
    reason: "Sign in so the agent can continue.",
    state: "pending",
    target: { environmentId: EnvironmentId.make("vps"), path: "provider.setup" },
  };
  it("opens provider accounts on the requested driver and instance", async () => {
    harness.open.mockResolvedValue({
      _tag: "Success",
      value: {
        human: {
          location: "Sign in to Claude on vps",
          providerSetup: {
            driver: "claudeAgent",
            instanceId: ProviderInstanceId.make("claudeAgent"),
          },
        },
      },
    });
    await render(request);
    expect(container.textContent).not.toContain("Open setup");
    await click("Review request");
    expect(container.textContent).toContain("Sign in to Claude on vps");
    await click("Open setup");
    expect(harness.navigate).toHaveBeenCalledWith("SettingsSheet", {
      screen: "SettingsContent",
      params: {
        screen: "SettingsProviderAccounts",
        params: {
          environmentId: EnvironmentId.make("vps"),
          driver: "claudeAgent",
          instanceId: ProviderInstanceId.make("claudeAgent"),
        },
      },
    });
    expect(harness.respond).not.toHaveBeenCalled();
  });
  it("does not offer setup for other provider requests", async () => {
    await render({
      ...request,
      target: { ...request.target, path: "provider.home_request" },
    });
    await click("Review request");
    expect(container.textContent).not.toContain("Open setup");
    expect(harness.navigate).not.toHaveBeenCalled();
  });
  it("needs permission to manage providers on the target", async () => {
    await act(async () => harness.manage(registry, false));
    await render(request);
    const review = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === "Review request",
    );
    expect(review?.disabled).toBe(true);
    expect(container.textContent).not.toContain("Open setup");
  });
});

describe("OpenCodex Home approval", () => {
  const request = {
    ...handoff,
    title: "Use OpenCodex Home",
    state: "pending" as const,
    target: { environmentId: EnvironmentId.make("vps"), path: "provider.home_request" },
  };
  it.each(["connect", "disconnect"] as const)(
    "reviews private %s instructions and refreshes the target without claiming application",
    async (action) => {
      harness.open.mockResolvedValue({
        _tag: "Success",
        value: { human: { location: `${action} on vps-1` } },
      });
      await render(request);
      expect(container.textContent).not.toContain(`${action} on vps-1`);
      await click("Review request");
      expect(container.textContent).toContain(`${action} on vps-1`);
      await click("Approve");
      expect(harness.respond).toHaveBeenCalledWith({
        environmentId,
        input: {
          threadId: handoff.requestedBy.threadId,
          handoffId: handoff.handoffId,
          action: "completed",
        },
      });
      expect(harness.refreshProviders).toHaveBeenCalledWith({
        environmentId: "vps",
        input: { fresh: true, refreshModels: true },
      });
      expect(harness.refresh).not.toHaveBeenCalled();
      await render({ ...request, state: "completed" });
      expect(container.textContent).toContain("Approved");
      expect(container.textContent).not.toContain("in Settings");
      expect(container.textContent).not.toContain("Waiting for GOAT to apply the route");
      expect(container.textContent).not.toContain("is ready for agents");
    },
  );
  it.each([
    ["Decline", "declined"],
    ["Cancel request", "cancelled"],
  ] as const)("sends %s without refreshing or applying a route", async (label, action) => {
    await render(request);
    await click(label);
    expect(harness.respond).toHaveBeenCalledWith({
      environmentId,
      input: { threadId: handoff.requestedBy.threadId, handoffId: handoff.handoffId, action },
    });
    expect(harness.refreshProviders).not.toHaveBeenCalled();
  });
  it("removes private approval instructions after target permission is revoked", async () => {
    await render(request);
    await click("Review request");
    expect(container.textContent).toContain("SHA256:test-host-key");
    await act(async () => harness.manage(registry, false));
    expect(container.textContent).not.toContain("SHA256:test-host-key");
    await click("Review request");
    expect(harness.open).toHaveBeenCalledTimes(1);
    expect(harness.respond).not.toHaveBeenCalled();
  });
  it.each(["expired", "declined", "cancelled", "failed"] as const)(
    "does not offer approval for a %s request",
    async (state) => {
      await render({ ...request, state });
      expect(
        [...container.querySelectorAll("button")].some(
          (button) => button.textContent === "Review request",
        ),
      ).toBe(false);
      expect(harness.respond).not.toHaveBeenCalled();
      expect(harness.refresh).not.toHaveBeenCalled();
    },
  );
});

it("shows successful pin-only approval as the agent's next step", async () => {
  const trust = { ...handoff, target: { ...handoff.target, path: "ssh.host_add" } };
  await render({ ...trust, state: "pending" });
  await click("Review request");
  await click("Approve");
  expect(harness.respond.mock.lastCall?.[0].input.action).toBe("completed");
  await render({ ...trust, resolvedAt: DateTime.makeUnsafe(0) });
  await publish({ ...diagnosis, result: { kind: "ok", status: { ...runtime, state: "stopped" } } });
  expect(container.textContent).toContain("Host key pinned. The agent can continue.");
  expect(container.textContent).not.toContain("expired or was replaced");
  expect(container.textContent).not.toContain("GOAT is setting up");
  expect(container.textContent).not.toContain("ready for agents");
});
it.each(["expired", "superseded"] as const)("preserves real %s trust requests", async (reason) => {
  await render({ ...handoff, target: { ...handoff.target, path: "ssh.host_add" } });
  await publish({ kind: "unavailable", reason });
  expect(container.textContent).toContain(
    "This request expired or was replaced. Ask the agent again.",
  );
  expect(container.textContent).not.toContain("Host key pinned");
});
it("preserves a failed pin after approval", async () => {
  await render({ ...handoff, target: { ...handoff.target, path: "ssh.host_add" } });
  await publish({
    ...diagnosis,
    result: {
      kind: "error",
      code: "operation_failed",
      message: "The SSH host key or destination changed. Add this host again to review it.",
    },
  });
  expect(container.textContent).toContain("The SSH host key or destination changed.");
  expect(container.textContent).not.toContain("Host key pinned");
});
