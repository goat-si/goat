import { fakeTimers } from "../../test/render";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { RelativeTimeLabel } from "./RelativeTimeLabel";

let root: Root;
let timers: Disposable;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  timers = fakeTimers();
  vi.setSystemTime(new Date("2026-10-12T12:00:59.000Z"));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  timers[Symbol.dispose]();
  vi.unstubAllGlobals();
});

it("updates the compact relative label at the minute boundary", async () => {
  await act(() => root.render(<RelativeTimeLabel timestamp="2026-10-12T12:00:00.000Z" />));
  expect(container.textContent).toBe("now");
  await act(() => vi.advanceTimersByTime(1000));
  expect(container.textContent).toBe("1m");
});
