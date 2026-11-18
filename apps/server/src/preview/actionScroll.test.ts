import type { Locator } from "playwright-core";
import { expect, it, vi } from "vite-plus/test";
import type { ReadinessGate } from "./actionReadiness.ts";
import { scrollIntoView } from "./actionScroll.ts";

const detached = () =>
  new Error("locator.scrollIntoViewIfNeeded: Element is not attached to the DOM");
const gate = Object.assign(async () => {}, {
  channel: { call: <T>(work: () => T) => work() },
}) as unknown as ReadinessGate;

it("re-resolves a selector replaced while scrolling", async () => {
  vi.useFakeTimers();
  try {
    const scroll = vi.fn().mockRejectedValueOnce(detached()).mockResolvedValue(undefined);
    await expect(
      scrollIntoView({ scrollIntoViewIfNeeded: scroll } as unknown as Locator, 100, gate),
    ).resolves.toBeUndefined();
    expect(scroll).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it("stops retrying at the action deadline", async () => {
  vi.useFakeTimers();
  try {
    const scroll = vi.fn(async () => {
      vi.advanceTimersByTime(60);
      throw detached();
    });
    await expect(
      scrollIntoView({ scrollIntoViewIfNeeded: scroll } as unknown as Locator, 100, gate),
    ).rejects.toThrow("not attached");
    expect(scroll).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it("does not retry after control is revoked", async () => {
  vi.useFakeTimers();
  try {
    const scroll = vi.fn(async () => {
      throw detached();
    });
    let checks = 0;
    const revoked = Object.assign(
      async () => {
        if (++checks > 1) throw new Error("control revoked");
      },
      { channel: { call: <T>(work: () => T) => work() } },
    ) as unknown as ReadinessGate;
    await expect(
      scrollIntoView({ scrollIntoViewIfNeeded: scroll } as unknown as Locator, 100, revoked),
    ).rejects.toThrow("control revoked");
    expect(scroll).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
