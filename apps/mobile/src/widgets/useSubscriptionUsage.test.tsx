import { Atom } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  active: false,
  listeners: new Set<() => void>(),
  refresh: vi.fn(() => Promise.resolve()),
}));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return fixture.active ? "active" : "background";
    },
    addEventListener: (_event: string, listener: () => void) => {
      fixture.listeners.add(listener);
      return { remove: () => fixture.listeners.delete(listener) };
    },
  },
}));
vi.mock("../state/atom-registry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});
vi.mock("../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentPresentations: { presentationsAtom: Atom.make(new Map()).pipe(Atom.keepAlive) },
  };
});
vi.mock("../state/server", () => ({ serverEnvironment: { refreshProviders: {} } }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => fixture.refresh }));

import { appAtomRegistry } from "../state/atom-registry";
import { environmentPresentations } from "../state/presentation";
import { WIDGET_REFRESH_INTERVAL } from "./subscriptionUsageSnapshot";
import { useSubscriptionUsage } from "./useSubscriptionUsage";

it("refreshes on resume, connection changes and intervals without recommitting the coordinator", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  fixture.active = false;
  fixture.refresh.mockClear();
  const presentations = environmentPresentations.presentationsAtom as unknown as Atom.Writable<
    Map<string, { connection: { phase: string } }>
  >;
  appAtomRegistry.set(presentations, new Map([["remote", { connection: { phase: "connected" } }]]));
  const rendered = vi.fn();
  function Coordinator() {
    useSubscriptionUsage();
    rendered();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Coordinator />));
    expect(fixture.refresh).not.toHaveBeenCalled();
    fixture.active = true;
    await act(async () => {
      for (const listener of fixture.listeners) listener();
    });
    expect(fixture.refresh).toHaveBeenCalledTimes(1);
    await act(async () =>
      appAtomRegistry.set(
        presentations,
        new Map([
          ["remote", { connection: { phase: "connected" } }],
          ["second", { connection: { phase: "connected" } }],
        ]),
      ),
    );
    expect(fixture.refresh).toHaveBeenCalledTimes(2);
    expect(rendered).toHaveBeenCalledTimes(1);
    expect(fixture.listeners.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => vi.advanceTimersByTime(WIDGET_REFRESH_INTERVAL));
    expect(fixture.refresh).toHaveBeenCalledTimes(4);
    fixture.active = false;
    await act(async () => vi.advanceTimersByTime(WIDGET_REFRESH_INTERVAL));
    expect(fixture.refresh).toHaveBeenCalledTimes(4);
  } finally {
    await act(async () => root.unmount());
    expect(fixture.listeners.size).toBe(0);
    appAtomRegistry.reset();
    vi.useRealTimers();
  }
});
