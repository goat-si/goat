import { expect, it, vi } from "vite-plus/test";

import { awaitRevealedViewer, viewerArrived } from "./ServerBrowserRevealWait.ts";

const hiddenTab = () => ({
  viewers: new Set<unknown>(),
  desktop: null as { readonly close: () => Promise<void> } | null,
  viewerAttached: null as PromiseWithResolvers<void> | null,
});

const tracked = (wait: Promise<void>) => {
  const state = { settled: false };
  void wait.then(() => {
    state.settled = true;
  });
  return state;
};

it("an explicit show answers as soon as a client attaches to the revealed tab", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const tab = hiddenTab();
    const wait = tracked(awaitRevealedViewer(tab, true, Number.POSITIVE_INFINITY));
    await vi.advanceTimersByTimeAsync(400);
    expect(wait.settled).toBe(false);
    tab.viewers.add({});
    viewerArrived(tab);
    await vi.advanceTimersByTimeAsync(0);
    expect(wait.settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("with no client, an explicit show answers after one second or at an earlier deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  using _now = vi.spyOn(performance, "now").mockReturnValue(0);
  try {
    const unseen = tracked(awaitRevealedViewer(hiddenTab(), true, Number.POSITIVE_INFINITY));
    const due = tracked(awaitRevealedViewer(hiddenTab(), true, 300));
    await vi.advanceTimersByTimeAsync(300);
    expect([unseen.settled, due.settled]).toEqual([false, true]);
    await vi.advanceTimersByTimeAsync(699);
    expect(unseen.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(unseen.settled).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("does not wait without an explicit show, for a shown tab or for a desktop tab", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const shown = hiddenTab();
    shown.viewers.add({});
    const desktop = { ...hiddenTab(), desktop: { close: async () => {} } };
    await awaitRevealedViewer(hiddenTab(), undefined, Number.POSITIVE_INFINITY);
    await awaitRevealedViewer(hiddenTab(), false, Number.POSITIVE_INFINITY);
    await awaitRevealedViewer(shown, true, Number.POSITIVE_INFINITY);
    await awaitRevealedViewer(desktop, true, Number.POSITIVE_INFINITY);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
