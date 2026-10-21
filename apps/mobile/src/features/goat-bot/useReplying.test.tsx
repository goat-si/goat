import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useReplying } from "./useReplying";

let root: Root;
let renders: boolean[];
const now = Date.UTC(2026, 9, 15);
function Probe(props: { since: string | null; visible: boolean }) {
  const replying = useReplying(props.since, props.visible);
  renders.push(replying);
  return replying ? "Replying" : null;
}
function render(since: string | null, visible = true) {
  act(() => root.render(<Probe since={since} visible={visible} />));
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(now);
  renders = [];
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});
it.each([91_000, 90_000])("never shows expired replying state aged %d ms", (age) => {
  render(new Date(now - age).toISOString());
  expect(renders).toEqual([false]);
  expect(vi.getTimerCount()).toBe(0);
});
it.each([null, "invalid"])("ignores absent or invalid timestamps: %s", (since) => {
  render(since);
  expect(renders).toEqual([false]);
  expect(vi.getTimerCount()).toBe(0);
});
it("expires an active reply at its deadline and accepts a new reply", () => {
  render(new Date(now - 89_000).toISOString());
  expect(renders.at(-1)).toBe(true);
  act(() => vi.advanceTimersByTime(999));
  expect(renders.at(-1)).toBe(true);
  act(() => vi.advanceTimersByTime(1));
  expect(renders.at(-1)).toBe(false);
  render(new Date(now + 1_000).toISOString());
  expect(renders.at(-1)).toBe(true);
  expect(vi.getTimerCount()).toBe(1);
});
it("clears timers while hidden and never flashes on an expired return", () => {
  const since = new Date(now).toISOString();
  render(since);
  render(since, false);
  expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(91_000));
  renders = [];
  render(since);
  expect(renders).toEqual([false]);
  expect(vi.getTimerCount()).toBe(0);
});
it("clears its expiry timer when replying state is removed", () => {
  render(new Date(now).toISOString());
  render(null);
  expect(vi.getTimerCount()).toBe(0);
});
