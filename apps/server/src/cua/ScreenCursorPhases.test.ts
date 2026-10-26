import { describe, expect, it } from "@effect/vitest";

import { ScreenCursorPhases } from "./ScreenCursorPhases.ts";

const ref = {
  id: "target",
  kind: "app" as const,
  environmentId: "environment",
  runId: "run",
  turnId: "turn",
  generation: 1,
};

describe("ScreenCursorPhases", () => {
  it("rearms thinking for each host call and never emits idle motion after end", () => {
    const events: Array<{ phase: string; sequence: number }> = [];
    const phases = new ScreenCursorPhases((event) => events.push({ phase: event.phase, sequence: event.identity.sequence }));
    phases.hostCallStarted(ref, 1);
    phases.hostCallSettled(ref, 1);
    phases.hostCallStarted(ref, 2);
    phases.ended(ref);
    phases.hostCallSettled(ref, 2);
    expect(events).toEqual([
      { phase: "thinking", sequence: 1 },
      { phase: "idle", sequence: 2 },
      { phase: "thinking", sequence: 3 },
      { phase: "hidden", sequence: 4 },
    ]);
  });

  it("ignores a late previous generation settle", () => {
    const events: string[] = [];
    const phases = new ScreenCursorPhases((event) => events.push(`${event.identity.generation}:${event.phase}`));
    phases.hostCallStarted(ref, 1);
    phases.hostCallStarted({ ...ref, generation: 2 }, 2);
    phases.hostCallSettled(ref, 1);
    expect(events).toEqual(["1:thinking", "2:thinking"]);
  });
});
