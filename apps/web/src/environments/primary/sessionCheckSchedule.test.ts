import type { EnvironmentConnectionPresentation } from "@goat/client-runtime/connection";
import { expect, it, vi } from "vite-plus/test";

import type { PrimarySessionAnswer } from "./auth";
import { createPrimarySessionCheck } from "./sessionCheckSchedule";

type Connection = Pick<EnvironmentConnectionPresentation, "phase" | "failure">;
const CONNECTED: Connection = { phase: "connected" };
const DROPPED: Connection = {
  phase: "reconnecting",
  failure: { kind: "retrying", reason: "transport", detail: "Socket closed" },
};
const UNREACHABLE: Connection = {
  phase: "reconnecting",
  failure: { kind: "retrying", reason: "host-unreachable", detail: "No route" },
};

function fakeTimers(): Disposable {
  vi.useFakeTimers();
  return { [Symbol.dispose]: () => vi.useRealTimers() };
}

/** This tab's own server as the check sees it, with a subscriber holding the check open. */
function primary({ eligible = true }: { eligible?: boolean } = {}) {
  const connectionListeners = new Set<() => void>();
  const visibleListeners = new Set<() => void>();
  const tab = {
    connection: { phase: "connecting" } as Connection | null,
    visible: true,
    probes: 0,
    answer: (): Promise<PrimarySessionAnswer> => Promise.resolve("unknown"),
    changes: 0,
    set(connection: Connection) {
      tab.connection = connection;
      for (const listener of connectionListeners) listener();
    },
    show(visible: boolean) {
      tab.visible = visible;
      for (const listener of visibleListeners) listener();
    },
  };
  const check = createPrimarySessionCheck({
    connection: () => tab.connection,
    subscribeConnection: (listener) => {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
    visible: () => tab.visible,
    subscribeVisible: (listener) => {
      visibleListeners.add(listener);
      return () => visibleListeners.delete(listener);
    },
    eligible: () => eligible,
    probe: () => {
      tab.probes += 1;
      return tab.answer();
    },
  });
  const hold = () => {
    const stop = check.subscribe(() => {
      tab.changes += 1;
    });
    return { [Symbol.dispose]: stop };
  };
  return { tab, check, hold };
}

const seconds = (value: number) => vi.advanceTimersByTimeAsync(value * 1_000);

it("checks 5, 10, 20, 40, 80 and 160 s apart, then every 5 minutes: 16 reads in an hour", async () => {
  using _timers = fakeTimers();
  const { tab, hold } = primary();
  using _held = hold();
  tab.set(CONNECTED);
  tab.set(DROPPED);
  const at: Array<number> = [];
  for (let second = 1; second <= 3_600; second++) {
    await seconds(1);
    if (tab.probes > at.length) at.push(second);
  }
  expect(at).toEqual([
    5, 15, 35, 75, 155, 315, 615, 915, 1215, 1515, 1815, 2115, 2415, 2715, 3015, 3315,
  ]);
});

it("guard: reads nothing before the computer has connected in this tab, while it is connected, or while it fails another way", async () => {
  using _timers = fakeTimers();
  const { tab, hold } = primary();
  using _held = hold();
  tab.set(DROPPED);
  await seconds(600);
  tab.set(CONNECTED);
  await seconds(600);
  tab.set(UNREACHABLE);
  await seconds(600);
  expect(tab.probes).toBe(0);
});

it("guard: reads nothing in a tab that is not signed in to its own server by cookie", async () => {
  using _timers = fakeTimers();
  const { tab, hold } = primary({ eligible: false });
  using _held = hold();
  tab.set(CONNECTED);
  tab.set(DROPPED);
  await seconds(3_600);
  expect(tab.probes).toBe(0);
});

it("keeps one read in flight at a time", async () => {
  using _timers = fakeTimers();
  const { tab, hold } = primary();
  tab.answer = () => new Promise(() => {});
  using _held = hold();
  tab.set(CONNECTED);
  tab.set(DROPPED);
  await seconds(3_600);
  expect(tab.probes).toBe(1);
});

it("a session that is gone marks the computer revoked and stops reading until it connects again", async () => {
  using _timers = fakeTimers();
  const { tab, check, hold } = primary();
  tab.answer = () => Promise.resolve("revoked");
  using _held = hold();
  tab.set(CONNECTED);
  tab.set(DROPPED);
  await seconds(5);
  expect(check.revoked()).toBe(true);
  expect(tab.changes).toBe(1);
  tab.set(DROPPED);
  await seconds(3_600);
  expect(tab.probes).toBe(1);
  tab.set(CONNECTED);
  expect(check.revoked()).toBe(false);
  expect(tab.changes).toBe(2);
});

it("a signed-in answer stops reading until the computer connects again, then starts over at 5 s", async () => {
  using _timers = fakeTimers();
  const { tab, check, hold } = primary();
  tab.answer = () => Promise.resolve("signed-in");
  using _held = hold();
  tab.set(CONNECTED);
  tab.set(DROPPED);
  await seconds(5);
  // Every failed reconnect is another dropped socket; none of them starts reading again.
  tab.set(DROPPED);
  await seconds(3_600);
  expect(tab.probes).toBe(1);
  expect(check.revoked()).toBe(false);
  tab.set(CONNECTED);
  tab.set(DROPPED);
  await seconds(4);
  expect(tab.probes).toBe(1);
  await seconds(1);
  expect(tab.probes).toBe(2);
});

it("pauses while the tab is hidden and reads once when it is shown again", async () => {
  using _timers = fakeTimers();
  const { tab, hold } = primary();
  using _held = hold();
  tab.set(CONNECTED);
  tab.set(DROPPED);
  tab.show(false);
  await seconds(3_600);
  expect(tab.probes).toBe(0);
  tab.show(true);
  await seconds(0);
  expect(tab.probes).toBe(1);
  await seconds(9);
  expect(tab.probes).toBe(1);
  await seconds(1);
  expect(tab.probes).toBe(2);
});

it("keeps its schedule when the last reader unmounts and another mounts", async () => {
  using _timers = fakeTimers();
  const { tab, hold } = primary();
  const first = hold();
  tab.set(CONNECTED);
  tab.set(DROPPED);
  await seconds(4);
  first[Symbol.dispose]();
  using _again = hold();
  await seconds(1);
  expect(tab.probes).toBe(1);
  await seconds(9);
  expect(tab.probes).toBe(1);
  await seconds(1);
  expect(tab.probes).toBe(2);
});
