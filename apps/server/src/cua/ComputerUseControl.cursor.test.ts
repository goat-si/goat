import { EnvironmentId, ThreadId } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { targeted, type ComputerUseControl } from "./ComputerUseControl.ts";

const owner = {
  environmentId: EnvironmentId.make("environment"),
  runId: "run",
  turnId: "turn",
  targetId: "target",
  generation: 1,
};
const control: ComputerUseControl = {
  controlId: "control",
  threadId: ThreadId.make("thread"),
  expiresAt: DateTime.makeUnsafe("2030-01-01T00:00:00.000Z"),
  target: { pid: 4, windowId: 9 },
};

describe("scoped computer-use cursor", () => {
  it("retains a newer tombstone and refuses a late previous-run show", () => {
    const point = { windowId: 9, point: { fx: 0.5, fy: 0.5 }, phase: "moving" } as const;
    const shown = targeted(control, {
      report: { identity: { ...owner, sequence: 1 }, cursor: point, phase: "moving" },
    })!;
    const hidden = targeted(shown, {
      report: { identity: { ...owner, sequence: 2 }, cursor: null, phase: "hidden" },
    })!;
    expect(hidden.cursor).toBeUndefined();
    expect(hidden.cursorReport?.identity.sequence).toBe(2);
    expect(targeted(hidden, {
      report: { identity: { ...owner, sequence: 1 }, cursor: point, phase: "moving" },
    })).toBeUndefined();
    expect(targeted(hidden, {
      report: { identity: { ...owner, generation: 2, sequence: 1 }, cursor: point, phase: "moving" },
    })?.cursor).toEqual(point);
  });
});
