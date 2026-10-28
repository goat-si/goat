import { describe, expect, it } from "vite-plus/test";
import {
  makeLoopObserver,
  restartDelayMs,
  recordRestart,
  emptyRecoveryRecord,
} from "./managedRecoveryPolicy.ts";

describe("managed recovery policy", () => {
  it("caps both jitter edges after exponential growth", () => {
    expect(restartDelayMs(0, 0)).toBe(500);
    expect(restartDelayMs(0, 1)).toBe(1000);
    expect(restartDelayMs(99, 0)).toBe(15000);
    expect(restartDelayMs(99, 1)).toBe(30000);
  });
  it("six ready-then-fail cycles pause and a backwards wall clock cannot restore budget", () => {
    let state = emptyRecoveryRecord();
    for (let n = 0; n < 5; n++) state = recordRestart(state, 1000 + n, "A", "exit80");
    expect(state.attempts).toHaveLength(5);
    state = recordRestart(state, 999, "B", "exit80");
    expect(state.pause).toBe("crash-loop");
    expect(recordRestart(state, 9999999, "C", "exit80").pause).toBe("crash-loop");
    expect(state.attempts).toHaveLength(5);
  });
  it("arms before the first heartbeat, grants absolute startup grace and a fresh silence window", () => {
    const observer = makeLoopObserver(0);
    for (let now = 2000; now <= 1800000; now += 2000)
      expect(observer.sample(now, 0, false, false)).not.toBe("main-silent");
    for (let now = 1802000; now < 1846000; now += 2000)
      expect(observer.sample(now, 0, false, false)).not.toBe("main-silent");
    expect(observer.sample(1846000, 0, false, false)).toBe("main-silent");
  });
  it("late observer ticks rebase; regular beats beyond startup grace remain slow and alive", () => {
    const observer = makeLoopObserver(0);
    expect(observer.sample(1800001, 1, false, false)).toBe("startup-slow");
    expect(observer.sample(1900000, 1, true, false)).not.toBe("main-silent");
    for (let now = 1902000; now < 1946000; now += 2000)
      expect(observer.sample(now, 1, true, false)).not.toBe("main-silent");
    expect(observer.sample(1946000, 1, true, false)).toBe("main-silent");
  });
});
