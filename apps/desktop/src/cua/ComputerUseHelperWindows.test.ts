import { assert, describe, it } from "@effect/vitest";

import {
  type WindowsReadiness,
  windowsReadinessBlocker,
  windowsReadinessFailure,
} from "./ComputerUseHelperWindows.ts";

// The helper's answer from a signed-in console session on mini.
const READY: WindowsReadiness = {
  accessibility: true,
  screenRecording: true,
  interactiveSession: true,
  connectState: "active",
  inputDesktop: "Default",
  uiAutomation: true,
  helperElevated: false,
};

describe("Windows computer use readiness", () => {
  it("names each way a desktop is not usable with its own reason, and none when it is", () => {
    assert.isUndefined(windowsReadinessFailure(READY));
    const states: ReadonlyArray<Partial<WindowsReadiness>> = [
      // Session 0, as the helper answers there.
      {
        accessibility: false,
        screenRecording: false,
        interactiveSession: false,
        connectState: "none",
        inputDesktop: "unavailable",
        uiAutomation: false,
        helperElevated: true,
      },
      { helperElevated: true },
      { connectState: "disconnected", screenRecording: false },
      {
        inputDesktop: "Winlogon",
        accessibility: false,
        screenRecording: false,
        uiAutomation: false,
      },
      { uiAutomation: false, accessibility: false },
      { connectState: "connected", screenRecording: false },
    ];
    const reasons = states.map((state) => windowsReadinessFailure({ ...READY, ...state }));
    for (const reason of reasons) assert.isString(reason);
    assert.equal(new Set(reasons).size, states.length);
    assert.match(reasons[0] ?? "", /Session 0/);
    assert.match(reasons[3] ?? "", /locked/);
    // The typed cause names the same failure as the reason, and only where one fits.
    assert.deepEqual(
      states.map((state) => windowsReadinessBlocker({ ...READY, ...state })),
      [
        "noInteractiveDesktop",
        undefined,
        "noInteractiveDesktop",
        "screenLocked",
        undefined,
        undefined,
      ],
    );
    assert.isUndefined(
      windowsReadinessBlocker({ ...READY, helperElevated: true, connectState: "disconnected" }),
    );
    assert.isUndefined(windowsReadinessBlocker(READY));
  });
});
