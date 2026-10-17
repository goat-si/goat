// @vitest-environment jsdom
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
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  open: vi.fn(),
  respond: vi.fn(),
  refresh: vi.fn(),
  publish: (_registry: AtomRegistry.AtomRegistry, _value: SshHandoffProgressResult) => {},
}));
vi.mock("../../state/server", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const progress = Atom.make<AtomAsyncResult.AsyncResult<SshHandoffProgressResult, never>>(
    AsyncResult.initial(),
  );
  harness.publish = (registry, value) => registry.set(progress, AsyncResult.success(value));
  return {
    serverEnvironment: Object.fromEntries(
      ["openHandoff", "respondHandoff", "trustSshHost", "prepareSshHost"].map((label) => [
        label,
        { label, permissionAtom: () => allowed },
      ]),
    ),
    sshHost: { handoffProgress: () => progress, refreshHandoffProgress: harness.refresh },
  };
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) =>
    command.label === "openHandoff" ? harness.open : harness.respond,
}));
import { HandoffCard } from "./HandoffCard";

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
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
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
  harness.refresh.mockReset();
});
afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  registry.dispose();
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const render = async (record: Handoff = handoff) => {
  await act(async () =>
    root.render(
      <RegistryContext value={registry}>
        <HandoffCard environmentId={environmentId} handoff={record} inherited={false} />
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
describe("SSH human handoff", () => {
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
