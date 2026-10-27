import { canSnooze } from "@goat/client-runtime/state/thread-settled";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import { minuteTickToEpochMs, useNowAfter } from "./clock";

function SnoozeClock(props: { deadlineMs: number; latestUserMessageAt: string }) {
  const nowMs = useNowAfter(props.deadlineMs);
  const snoozable = canSnooze(
    {
      latestUserMessageAt: props.latestUserMessageAt,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
    },
    { now: new Date(nowMs).toISOString() },
  );
  return createElement(
    "div",
    null,
    createElement("output", null, nowMs),
    createElement("button", { disabled: !snoozable }, "Snooze"),
  );
}

it("advances the compiled clock and enables snooze after the queued-start grace expires", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  const latestUserMessageAt = "2026-06-01T03:00:00.000Z";
  const mountedAtMs = Date.parse(latestUserMessageAt);
  const deadlineMs = Date.parse("2026-06-01T03:02:00.001Z");
  vi.setSystemTime(mountedAtMs);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(createElement(SnoozeClock, { deadlineMs, latestUserMessageAt })),
    );
    expect(container.querySelector("output")?.textContent).toBe(String(mountedAtMs));
    expect(container.querySelector("button")?.disabled).toBe(true);

    act(() => vi.advanceTimersByTime(120_000));
    expect(container.querySelector("button")?.disabled).toBe(true);

    act(() => vi.advanceTimersByTime(1));
    expect(container.querySelector("output")?.textContent).toBe(String(deadlineMs));
    expect(container.querySelector("button")?.disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});

describe("minuteTickToEpochMs", () => {
  it("reads the minute tick as UTC regardless of the device timezone", () => {
    expect(minuteTickToEpochMs("2026-10-26T02:14")).toBe(Date.UTC(2026, 9, 26, 2, 14));
  });
});
