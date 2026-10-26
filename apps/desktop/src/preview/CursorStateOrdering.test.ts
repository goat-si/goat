import { expect, it } from "@effect/vitest";
import { EnvironmentId, type AgentCursorSnapshot } from "@goat/contracts";

import { acceptsCursorState } from "./CursorStateOrdering.ts";

const state = (sequence: number, phase: AgentCursorSnapshot["phase"]): AgentCursorSnapshot => ({
  identity: {
    environmentId: EnvironmentId.make("env"),
    runId: "run",
    turnId: "turn",
    targetId: "target",
    generation: 1,
    sequence,
  },
  phase,
});

it("ignores stale cursor updates and cannot revive a hidden cursor in the same generation", () => {
  expect(acceptsCursorState(state(2, "thinking"), state(1, "moving"))).toBe(false);
  expect(acceptsCursorState(state(2, "hidden"), state(3, "moving"))).toBe(false);
  expect(acceptsCursorState(state(2, "thinking"), state(3, "hidden"))).toBe(true);
  expect(acceptsCursorState(state(2, "hidden"), state(3, "hidden"))).toBe(true);
});
