import { fakeTimers } from "../../../test/render";
import { EnvironmentId, type GoatBotHomeClaim } from "@goat/contracts";
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useGlobalAgentStore } from "~/globalAgentStore";

interface RawEnvironment {
  environmentId: EnvironmentId;
  label: string;
  connection: { phase: "connected" | "disconnected" };
  serverConfig: {
    environment: { label: string; capabilities: { goatBotHome: boolean; channelLedger: boolean } };
    settings: { goatBotHome: GoatBotHomeClaim | null } | null;
  } | null;
}
const state = vi.hoisted(() => ({
  environments: [] as RawEnvironment[],
  permissions: new Set<EnvironmentId>(),
  persist: vi.fn(
    async (_request: {
      environmentId: EnvironmentId;
      input: { patch: { goatBotHome: GoatBotHomeClaim } };
    }) => ({ _tag: "Success" as "Success" | "Failure" }),
  ),
}));
const listeners = new Set<() => void>();
let version = 0;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const getVersion = () => version;
function useTick() {
  useSyncExternalStore(subscribe, getVersion);
}
vi.mock("~/state/environments", () => ({
  useEnvironments: () => {
    useTick();
    return { environments: state.environments };
  },
  usePrimaryEnvironmentId: () => state.environments[0]?.environmentId ?? null,
}));
vi.mock("~/state/server", () => ({ serverEnvironment: { updateSettings: {} } }));
vi.mock("~/state/session", () => ({
  useEnvironmentsWithScope: () => {
    useTick();
    return state.permissions;
  },
  readEnvironmentScope: (id: EnvironmentId) => state.permissions.has(id),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.persist }));
vi.mock("~/state/entities", () => ({ useThreadShell: () => null }));
import { useGoatBotHome, useGoatBotHomeSettings } from "./useGoatBotHome";

const a = EnvironmentId.make("a");
const b = EnvironmentId.make("b");
const c = EnvironmentId.make("c");
const claim = (id = a, claimedAt = 100, claimId = "winner"): GoatBotHomeClaim => ({
  environmentId: id,
  claimedAt,
  claimId,
});
function environment(id: EnvironmentId, home: GoatBotHomeClaim | null = null): RawEnvironment {
  return {
    environmentId: id,
    label: id,
    connection: { phase: "connected" },
    serverConfig: {
      environment: { label: id, capabilities: { goatBotHome: true, channelLedger: true } },
      settings: { goatBotHome: home },
    },
  };
}
let root: Root;
let container: HTMLDivElement;
let timers: Disposable;
function Observer() {
  useGoatBotHome();
  return null;
}
function ReadOnly() {
  const { resolution } = useGoatBotHomeSettings();
  return <output>{resolution.state}</output>;
}
async function render(reader = false) {
  await act(() => {
    version++;
    for (const listener of listeners) listener();
    root.render(reader ? <ReadOnly /> : <Observer />);
  });
}
async function advance(ms: number) {
  await act(() => vi.advanceTimersByTimeAsync(ms));
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  timers = fakeTimers();
  vi.setSystemTime(1_000);
  state.environments = [environment(a), environment(b)];
  state.permissions = new Set([a, b]);
  state.persist.mockReset();
  state.persist.mockResolvedValue({ _tag: "Success" });
  useGlobalAgentStore.setState({ ref: null, botRef: null });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  timers[Symbol.dispose]();
});

it("creates one shared claim and waits for raw snapshot readback without duplicate writes", async () => {
  await render();
  expect(state.persist).toHaveBeenCalledTimes(2);
  const requests = state.persist.mock.calls.map(([request]) => request);
  expect(requests.map((request) => request.environmentId)).toEqual([a, b]);
  expect(requests[0]!.input.patch.goatBotHome).toEqual(requests[1]!.input.patch.goatBotHome);
  expect(requests[0]!.input.patch.goatBotHome.environmentId).toBe(a);
  await render();
  await advance(60_000);
  expect(state.persist).toHaveBeenCalledTimes(2);
});

it("does not replace unloaded raw settings with defaults or write from read-only consumers", async () => {
  state.environments[1]!.serverConfig!.settings = null;
  await render(true);
  expect(container.textContent).toBe("unknown");
  expect(state.persist).not.toHaveBeenCalled();
  await render();
  expect(state.persist).not.toHaveBeenCalled();
});

it("requires candidate settings permission and excludes unsupported, disconnected and denied replicas", async () => {
  state.permissions = new Set([b]);
  await render();
  expect(state.persist).not.toHaveBeenCalled();
  state.permissions = new Set([a]);
  state.environments.push(environment(c));
  state.environments[2]!.serverConfig!.environment.capabilities.goatBotHome = false;
  await render();
  expect(state.persist).toHaveBeenCalledTimes(1);
  expect(state.persist.mock.calls[0]![0].environmentId).toBe(a);
});

it("wakes for partial failures at 2s then 8s without new snapshots", async () => {
  state.environments = [environment(a, claim()), environment(b)];
  state.persist
    .mockResolvedValueOnce({ _tag: "Failure" })
    .mockResolvedValueOnce({ _tag: "Failure" });
  await render();
  expect(state.persist).toHaveBeenCalledTimes(1);
  await advance(1_999);
  expect(state.persist).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(state.persist).toHaveBeenCalledTimes(2);
  await advance(7_999);
  expect(state.persist).toHaveBeenCalledTimes(2);
  await advance(1);
  expect(state.persist).toHaveBeenCalledTimes(3);
});

it("cancels old wakes on winner change and on unmount", async () => {
  state.environments = [environment(a, claim()), environment(b)];
  state.persist.mockResolvedValue({ _tag: "Failure" });
  await render();
  const newer = claim(b, 200, "new");
  state.environments = [environment(a, newer), environment(b)];
  await render();
  expect(state.persist).toHaveBeenCalledTimes(2);
  expect(state.persist.mock.calls[1]![0].input.patch.goatBotHome).toEqual(newer);
  await act(() => root.unmount());
  await advance(60_000);
  expect(state.persist).toHaveBeenCalledTimes(2);
  root = createRoot(container);
});

it("deduplicates in-flight writes and resets retry history on reconnect", async () => {
  state.environments = [environment(a, claim()), environment(b)];
  let finish: ((value: { _tag: "Failure" }) => void) | undefined;
  state.persist.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await render();
  expect(state.persist).toHaveBeenCalledTimes(1);
  await act(() => finish?.({ _tag: "Failure" }));
  state.environments = [
    environment(a, claim()),
    { ...environment(b), connection: { phase: "disconnected" } },
  ];
  await render();
  state.environments = [environment(a, claim()), environment(b)];
  await render();
  expect(state.persist).toHaveBeenCalledTimes(2);
});

it("writes to a supporting replica even when that replica cannot run the bot", async () => {
  state.environments = [environment(a, claim()), environment(b)];
  state.environments[1]!.serverConfig!.environment.capabilities.channelLedger = false;
  await render();
  expect(state.persist).toHaveBeenCalledTimes(1);
  expect(state.persist.mock.calls[0]![0].environmentId).toBe(b);
});

it("advances the maximum seen clock after a disk reset leaves the cluster unclaimed", async () => {
  state.environments = [environment(a, claim(a, 50_000)), environment(b, claim(a, 50_000))];
  await render();
  state.environments = [environment(a), environment(b)];
  await render();
  expect(state.persist.mock.calls[0]![0].input.patch.goatBotHome.claimedAt).toBe(50_001);
});

it("ignores a late pre-reconnect result while the new connection retries the same claim", async () => {
  state.environments = [environment(a, claim()), environment(b)];
  const completions: Array<(value: { _tag: "Failure" }) => void> = [];
  state.persist.mockImplementation(
    () =>
      new Promise((resolve) => {
        completions.push(resolve);
      }),
  );
  await render();
  state.environments = [
    environment(a, claim()),
    { ...environment(b), connection: { phase: "disconnected" } },
  ];
  await render();
  state.environments = [environment(a, claim()), environment(b)];
  await render();
  expect(state.persist).toHaveBeenCalledTimes(2);
  await act(() => completions[0]!({ _tag: "Failure" }));
  await advance(2_000);
  expect(state.persist).toHaveBeenCalledTimes(2);
  await act(() => completions[1]!({ _tag: "Failure" }));
  await advance(2_000);
  expect(state.persist).toHaveBeenCalledTimes(3);
});
