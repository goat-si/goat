// Lifted from GOAT v1 apps/desktop/src/backend/DesktopBackendRecoveryPolicy.test.ts; vite-plus assertions
// rewritten as node:assert, cases and values unchanged.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  restartDelayMs,
  recordRestart,
  emptyRecoveryRecord,
} from "./DesktopBackendRecoveryPolicy.ts";

describe("managed recovery policy", () => {
  it("caps both jitter edges after exponential growth", () => {
    assert.equal(restartDelayMs(0, 0), 500);
    assert.equal(restartDelayMs(0, 1), 1000);
    assert.equal(restartDelayMs(99, 0), 15000);
    assert.equal(restartDelayMs(99, 1), 30000);
  });
  it("six ready-then-fail cycles pause and a backwards wall clock cannot restore budget", () => {
    let state = emptyRecoveryRecord();
    for (let n = 0; n < 5; n++) state = recordRestart(state, 1000 + n, "A", "exit80");
    assert.equal(state.attempts?.length, 5);
    state = recordRestart(state, 999, "B", "exit80");
    assert.equal(state.pause, "crash-loop");
    assert.equal(recordRestart(state, 9999999, "C", "exit80").pause, "crash-loop");
    assert.equal(state.attempts?.length, 5);
  });
  it("notifies once for repeated slow crashes and again after a lapse", () => {
    let state = emptyRecoveryRecord();
    for (let n = 0; n < 4; n++) state = recordRestart(state, n * 20 * 60_000, String(n), "code=1");
    assert.equal(state.notifiedKey, "code=1");
    assert.equal(state.history?.length, 4);
    state = recordRestart(state, 7 * 60 * 60_000, "next", "code=1");
    assert.equal(state.notifiedKey, undefined);
    assert.equal(state.history?.length, 1);
  });
});

it("chooses the newest tied frequent outcome and caps the crash history", () => {
  let state = emptyRecoveryRecord();
  for (const [index, outcome] of ["a", "b", "a", "b", "c"].entries()) {
    state = recordRestart(state, index * 700_000, String(index), outcome);
  }
  assert.equal(state.notifiedKey, "b");
  for (let n = 5; n < 21; n++) state = recordRestart(state, n * 700_000, String(n), "a");
  assert.equal(state.history?.length, 8);
  assert.equal(state.notifiedKey, "a");
});

it("notifies again when three surviving exits form a new pattern", () => {
  let state = emptyRecoveryRecord();
  for (const at of [0, 1, 2, 3]) state = recordRestart(state, at * 60_000, "a", "same");
  assert.equal(state.notifiedKey, "same");
  state = recordRestart(state, 6 * 60 * 60_000 + 1, "b", "same");
  assert.equal(state.history?.length, 4);
  assert.equal(state.notifiedKey, "same");
});
