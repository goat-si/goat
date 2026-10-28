import { describe, expect, it } from "vite-plus/test";
import {
  restartDelayMs,
  recordRestart,
  emptyRecoveryRecord,
} from "./DesktopBackendRecoveryPolicy.ts";

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
});
