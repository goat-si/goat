import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ focused: true, active: true }));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => state.focused }));
vi.mock("../../lib/appState", () => ({ useAppActive: () => state.active }));

import { ThreadListPaneVisibleContext, ThreadListV2Duration } from "./thread-list-pane-clock";
import { useVisibleSecondClock } from "./use-visible-second-clock";

function Clock() {
  return <span>{useVisibleSecondClock(true)}</span>;
}

it("shares one timer across visible labels and releases it while hidden or inactive", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-01T03:00:00.000Z"));
  state.focused = true;
  state.active = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const view = () => (
    <>
      <Clock />
      <Clock />
    </>
  );
  try {
    await act(async () => root.render(view()));
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(1_000));
    const current = Date.parse("2026-06-01T03:00:01.000Z");
    expect([...container.querySelectorAll("span")].map((span) => span.textContent)).toEqual([
      String(current),
      String(current),
    ]);
    state.focused = false;
    await act(async () => root.render(view()));
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(5_000));
    expect(container.querySelector("span")?.textContent).toBe(String(current));
    state.focused = true;
    await act(async () => root.render(view()));
    expect(container.querySelector("span")?.textContent).toBe(String(current + 5_000));
    state.active = false;
    await act(async () => root.render(view()));
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});

it("keeps an always-visible pane's label ticking while its route is unfocused, until the app is inactive", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-01T03:00:00.000Z"));
  state.focused = false;
  state.active = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const Sidebar = () => <span>{useVisibleSecondClock(true, { whileUnfocused: true })}</span>;
  try {
    await act(async () => root.render(<Sidebar />));
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(3_000));
    expect(container.querySelector("span")?.textContent).toBe(
      String(Date.parse("2026-06-01T03:00:03.000Z")),
    );
    state.active = false;
    await act(async () => root.render(<Sidebar />));
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});

it("ticks a sidebar row's elapsed time only while the sidebar pane is shown", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-01T03:00:00.000Z"));
  state.focused = false;
  state.active = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const row = (shown: boolean) => (
    <ThreadListPaneVisibleContext value={shown}>
      <span>
        <ThreadListV2Duration startedAt="2026-06-01T02:59:00.000Z" />
      </span>
    </ThreadListPaneVisibleContext>
  );
  try {
    await act(async () => root.render(row(false)));
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => root.render(row(true)));
    expect(vi.getTimerCount()).toBe(1);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});
