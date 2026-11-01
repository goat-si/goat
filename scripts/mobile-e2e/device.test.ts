import { expect, it, vi } from "vite-plus/test";

import type { Snapshot } from "./checks.ts";
import { AgentDeviceError, Device, poolError } from "./device.ts";

const screen: Snapshot = { viewport: { width: 400, height: 800 }, nodes: [] };

/** Waits for a screen that never comes, reading snapshots from `reads` and then `last`. */
async function waitForMissingScreen(
  reads: ReadonlyArray<() => Promise<Snapshot>>,
  last: () => Promise<Snapshot>,
) {
  vi.useFakeTimers();
  try {
    const queue = [...reads];
    const device = Object.create(Device.prototype) as Device;
    device.snapshot = () => (queue.shift() ?? last)();
    const waiting = device
      .waitFor(() => false, "the thread screen", 5_000)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    return await waiting;
  } finally {
    vi.useRealTimers();
  }
}

const daemonClosed = async (): Promise<Snapshot> => {
  throw new AgentDeviceError("agent-device snapshot: Daemon connection closed");
};

it("a wait whose snapshots fail on the pool reports the pool's error", async () => {
  const error = await waitForMissingScreen([], daemonClosed);

  expect(error instanceof Error && poolError(error.message)).toBe(true);
});

it("a wait on a reachable device that never shows the screen is an app timeout", async () => {
  const error = await waitForMissingScreen([daemonClosed], async () => screen);

  expect(error).toEqual(new Error("timed out waiting for the thread screen"));
  expect(error instanceof Error && poolError(error.message)).toBe(false);
});
