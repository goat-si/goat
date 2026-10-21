import { EnvironmentId, type HostStatusEntry } from "@goat/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { PERSISTED_STATE_KEY, useUiStateStore } from "../../uiStateStore";

const environmentId = EnvironmentId.make("console-environment");
const SAMPLED_AT = Date.parse("2026-10-20T12:00:00.000Z");
const host: HostStatusEntry = {
  host: null,
  reachability: "ok",
  metrics: {
    sampledAt: SAMPLED_AT,
    cpuUtilization: 0.91,
    cpuCount: 10,
    availableMemoryBytes: 4,
    totalMemoryBytes: 16,
    loadAvg: { oneMinute: 17, fiveMinutes: 15, fifteenMinutes: 12 },
    disk: null,
    threads: { running: 0, waiting: 0, queued: 0 },
    quotas: [],
  },
};

const hostStatus = vi.hoisted(() => ({ reads: 0 }));
// Longer than two alert lines at 320px, so the wrap and the clamp are both exercised.
const LONG_VERSION = "0.1.0-dev.1791900000.g1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5";
const box: HostStatusEntry = {
  ...host,
  host: "box",
  versionMismatch: true,
  serverVersion: LONG_VERSION,
};
vi.mock(import("./fleetConsoleTelemetry"), async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    fleetConsoleTelemetryAtom: Atom.make(() => {
      hostStatus.reads += 1;
      return {
        reports: new Map([[environmentId, [host, box]]]),
        history: new Map(),
        lastSeen: new Map(),
        loading: false,
        failed: [],
        sampledAt: SAMPLED_AT,
        observedAt: SAMPLED_AT,
      };
    }),
  };
});

import { FleetConsoleSlot, loadFleetConsole } from "./FleetConsoleSlot";
import { fleetHeatDemo } from "./fleetHeatDemo";

const snapshot = {
  machines: [
    {
      id: "macmini",
      label: "macmini",
      subtitle: null,
      kind: "environment" as const,
      os: null,
      machineKind: null,
      environmentId,
      sshHost: null,
      boat: null,
      answering: true,
      running: 9,
      attention: 2,
      reported: 3,
      agents: [],
    },
  ],
  threads: [],
  totals: { running: 9, attention: 2, reported: 3, machines: 6 },
};

let container: HTMLDivElement;
let root: Root;
/** Idle callbacks the slot has requested; the test decides when the browser goes idle. */
let idleCallbacks: Map<number, IdleRequestCallback>;
let nextIdleHandle = 0;

function render() {
  return act(async () => {
    root.render(<FleetConsoleSlot snapshot={snapshot} connections={new Map()} heat={new Map()} />);
  });
}

const placeholder = () => container.querySelector<HTMLElement>("[data-fleet-console-placeholder]");
const console_ = () =>
  container.querySelector<HTMLElement>('section[aria-label="Fleet telemetry"]');
/** Let the browser go idle after first paint, then settle the same chunk import `lazy` awaits. */
async function mounted() {
  await act(async () => {
    const pending = [...idleCallbacks.values()];
    idleCallbacks.clear();
    for (const callback of pending) callback({ didTimeout: false, timeRemaining: () => 50 });
  });
  await act(() => loadFleetConsole());
  expect(console_()).not.toBeNull();
}
const toggle = () => container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;

function stubReducedMotion(reduced: boolean) {
  const real = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) =>
    query.includes("prefers-reduced-motion")
      ? ({
          matches: reduced,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        } as unknown as MediaQueryList)
      : real(query),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  idleCallbacks = new Map();
  vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
    idleCallbacks.set(++nextIdleHandle, callback);
    return nextIdleHandle;
  });
  vi.stubGlobal("cancelIdleCallback", (handle: number) => idleCallbacks.delete(handle));
  hostStatus.reads = 0;
  useUiStateStore.setState({ fleetConsoleCollapsed: false });
  container = document.createElement("div");
  container.style.width = "1100px";
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("FleetConsoleSlot", () => {
  it("holds the console's height with a placeholder until the page has painted, then swaps it in", async () => {
    await render();
    expect(console_()).toBeNull();
    const reserved = placeholder()!.getBoundingClientRect().height;
    expect(reserved).toBeGreaterThan(200);

    await mounted();
    expect(placeholder()).toBeNull();
    expect(console_()!.getBoundingClientRect().height).toBe(reserved);
    expect(console_()!.textContent).toContain("91%");
  });

  it("remembers that it was collapsed, and computes no telemetry while collapsed", async () => {
    await render();
    await mounted();
    await act(async () => toggle().click());

    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(console_()!.getBoundingClientRect().height).toBe(40);
    expect(console_()!.textContent).toContain("9 running");
    // The store debounces its writes and flushes them when the page unloads.
    window.dispatchEvent(new Event("beforeunload"));
    expect(JSON.parse(localStorage.getItem(PERSISTED_STATE_KEY)!).fleetConsoleCollapsed).toBe(true);

    await act(async () => root.unmount());
    hostStatus.reads = 0;
    root = createRoot(container);
    await render();
    expect(placeholder()!.getBoundingClientRect().height).toBe(40);
    await mounted();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(hostStatus.reads).toBe(0);

    await act(async () => toggle().click());
    // The atom may be served from the registry's cache, so check what the body shows.
    expect(console_()!.textContent).toContain("91%");
    expect(useUiStateStore.getState().fleetConsoleCollapsed).toBe(false);
  });

  it("sweeps once per sample, and not at all with reduced motion", async () => {
    stubReducedMotion(false);
    await render();
    await mounted();
    expect(container.querySelectorAll(".fleet-console-sweep")).toHaveLength(1);
    await act(async () => root.unmount());

    vi.restoreAllMocks();
    stubReducedMotion(true);
    root = createRoot(container);
    await render();
    await mounted();
    expect(console_()!.textContent).toContain("91%");
    expect(container.querySelector(".fleet-console-sweep")).toBeNull();
  });

  it("wraps a long alert to two lines, keeps its full text, and does not grow the panel", async () => {
    const version = LONG_VERSION;
    container.style.width = "320px";
    await render();
    const reserved = placeholder()!.getBoundingClientRect().height;
    await mounted();

    const alert = [...container.querySelectorAll<HTMLElement>("[data-fleet-alert]")].find((item) =>
      item.textContent?.includes(version),
    )!;
    const detail = alert.querySelector<HTMLElement>("[tabindex]")!;
    expect(detail.textContent).toBe("Runs GOAT " + version);
    const line = Number.parseFloat(getComputedStyle(detail).lineHeight);
    const height = detail.getBoundingClientRect().height;
    expect(height).toBeGreaterThan(line * 1.5);
    expect(height).toBeLessThanOrEqual(line * 2 + 1);
    expect(detail.scrollWidth).toBeLessThanOrEqual(detail.clientWidth);
    expect(console_()!.getBoundingClientRect().height).toBe(reserved);
  });

  it("counts answering servers in the Hosts header and puts the rest behind +N, adding no rows", async () => {
    // Two routes to one server, an unreachable server, a stopped Boat machine and an SSH host.
    const demo = fleetHeatDemo();
    await act(async () => {
      root.render(
        <FleetConsoleSlot
          snapshot={demo.snapshot}
          connections={demo.connections}
          heat={demo.heat}
        />,
      );
    });
    await mounted();
    const hosts = container.querySelector<HTMLElement>('section[aria-label="Hosts"]')!;
    const header = hosts.firstElementChild as HTMLElement;
    const chip = header.querySelector("button")!;
    const rows = hosts.querySelectorAll("li");

    expect(demo.snapshot.totals.machines).toBe(6);
    expect(header.textContent).toMatch(/^Hosts \d+\/6\+\d+/);
    // One row per graph machine, plus the host the mocked status read names; none for the count.
    expect(rows).toHaveLength(demo.snapshot.machines.length + 1);
    expect(rows).toHaveLength(demo.snapshot.totals.machines + Number(chip.textContent!.slice(1)));
    expect(chip.getAttribute("aria-label")).toContain("clisu-oracle, Unreachable");
    expect(chip.getAttribute("aria-label")).toContain("nightly-ci, Boat · Stopped");
    expect(chip.getAttribute("aria-label")).toContain("gpu-box, SSH host · via mac-studio");

    const withChip = header.getBoundingClientRect().height;
    chip.style.display = "none";
    expect(header.getBoundingClientRect().height).toBe(withChip);
  });
});
