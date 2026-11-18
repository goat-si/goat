import { expect, it, vi } from "vite-plus/test";
import { withinStatusDeadline } from "./statusDeadline.ts";

it("answers a stalled status read with the last known value and ignores a late answer", async () => {
  vi.useFakeTimers();
  const pending = Promise.withResolvers<string>();
  try {
    const answer = withinStatusDeadline(pending.promise, () => "last known");
    await vi.advanceTimersByTimeAsync(250);
    expect(await answer).toBe("last known");
    pending.resolve("late");
    expect(await pending.promise).toBe("late");
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
