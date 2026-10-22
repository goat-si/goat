import { fakeTimers } from "../../../test/render";
import { EnvironmentId, type GoatBotHomeClaim } from "@goat/contracts";
import { act, StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  environments: [] as Array<{
    environmentId: EnvironmentId;
    connected: boolean;
    supportsChannelLedger: boolean;
    primary: boolean;
    homeTarget: {
      environmentId: EnvironmentId;
      connected: boolean;
      supportsHome: boolean;
      supportsBot: boolean;
      settingsLoaded: boolean;
      home: GoatBotHomeClaim | null;
    };
  }>,
  permissions: new Set<EnvironmentId>(),
  persist: vi.fn(
    async (_request: {
      environmentId: EnvironmentId;
      input: { patch: { goatBotHome: GoatBotHomeClaim } };
    }) => ({ _tag: "Success" as "Success" | "Failure" }),
  ),
}));
vi.mock("./goatBotHooks", () => ({ useGoatBotEnvironments: () => state.environments }));
vi.mock("~/globalAgentStore", () => ({ useGlobalAgentStore: () => null }));
vi.mock("~/state/server", () => ({ serverEnvironment: { updateSettings: {} } }));
vi.mock("~/state/session", () => ({
  useEnvironmentsWithScope: () => state.permissions,
  readEnvironmentScope: (id: EnvironmentId) => state.permissions.has(id),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.persist }));

import { useGoatBotHome } from "./useGoatBotHome";

it("keeps deferred writes across StrictMode cleanup/setup, wakes retries and cleans timers", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  using _timers = fakeTimers();
  vi.setSystemTime(1_000);
  const a = EnvironmentId.make("a");
  const b = EnvironmentId.make("b");
  state.environments = [a, b].map((environmentId) => ({
    environmentId,
    connected: true,
    supportsChannelLedger: true,
    primary: environmentId === a,
    homeTarget: {
      environmentId,
      connected: true,
      supportsHome: true,
      supportsBot: true,
      settingsLoaded: true,
      home: null,
    },
  }));
  state.permissions = new Set([a, b]);
  const completions: Array<(value: { _tag: "Success" | "Failure" }) => void> = [];
  state.persist.mockImplementation(() => new Promise((resolve) => completions.push(resolve)));
  const lifecycle: string[] = [];
  function Observer() {
    useGoatBotHome();
    useEffect(() => {
      lifecycle.push("setup");
      return () => {
        lifecycle.push("cleanup");
      };
    }, []);
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <StrictMode>
          <Observer />
        </StrictMode>,
      ),
    );
    expect(lifecycle).toEqual(["setup", "cleanup", "setup"]);
    expect(state.persist).toHaveBeenCalledTimes(2);
    const claim = state.persist.mock.calls[0]![0].input.patch.goatBotHome;
    expect(state.persist.mock.calls[1]![0].input.patch.goatBotHome).toEqual(claim);
    await act(() => {
      completions[0]!({ _tag: "Success" });
      completions[1]!({ _tag: "Failure" });
    });
    expect(vi.getTimerCount()).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(1_999));
    expect(state.persist).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(state.persist).toHaveBeenCalledTimes(3);
    expect(state.persist.mock.calls[2]![0]).toEqual({
      environmentId: b,
      input: { patch: { goatBotHome: claim } },
    });
    await act(() => completions[2]!({ _tag: "Failure" }));
    expect(vi.getTimerCount()).toBe(1);
    await act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(state.persist).toHaveBeenCalledTimes(3);
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
