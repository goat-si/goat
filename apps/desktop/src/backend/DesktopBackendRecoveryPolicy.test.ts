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
  it("notifies once for repeated slow crashes and again after a lapse", () => {
    let state = emptyRecoveryRecord();
    for (let n = 0; n < 4; n++) state = recordRestart(state, n * 20 * 60_000, String(n), "code=1");
    expect(state.notifiedKey).toBe("code=1");
    expect(state.history).toHaveLength(4);
    state = recordRestart(state, 7 * 60 * 60_000, "next", "code=1");
    expect(state.notifiedKey).toBeUndefined();
    expect(state.history).toHaveLength(1);
  });
});

it("chooses the newest tied frequent outcome and caps the crash history", () => {
  let state = emptyRecoveryRecord();
  for (const [index, outcome] of ["a", "b", "a", "b", "c"].entries()) {
    state = recordRestart(state, index * 700_000, String(index), outcome);
  }
  expect(state.notifiedKey).toBe("b");
  for (let n = 5; n < 21; n++) state = recordRestart(state, n * 700_000, String(n), "a");
  expect(state.history).toHaveLength(8);
  expect(state.notifiedKey).toBe("a");
});

it("notifies again when three surviving exits form a new pattern", () => {
  let state = emptyRecoveryRecord();
  for (const at of [0, 1, 2, 3]) state = recordRestart(state, at * 60_000, "a", "same");
  expect(state.notifiedKey).toBe("same");
  state = recordRestart(state, 6 * 60 * 60_000 + 1, "b", "same");
  expect(state.history).toHaveLength(4);
  expect(state.notifiedKey).toBe("same");
});
