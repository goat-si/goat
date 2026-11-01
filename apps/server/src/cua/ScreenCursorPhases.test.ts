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
  it("rearms thinking for each host call and never emits resting motion after end", () => {
    const events: Array<{ phase: string; sequence: number }> = [];
    const phases = new ScreenCursorPhases((event) =>
      events.push({ phase: event.phase, sequence: event.identity.sequence }),
    );
    phases.hostCallStarted(ref, 1);
    phases.hostCallSettled(ref, 1);
    phases.hostCallStarted(ref, 2);
    phases.ended(ref);
    phases.hostCallSettled(ref, 2);
    expect(events).toEqual([
      { phase: "thinking", sequence: 1 },
      { phase: "resting", sequence: 2 },
      { phase: "thinking", sequence: 3 },
      { phase: "hidden", sequence: 4 },
    ]);
  });

  it("ignores a late previous generation settle", () => {
    const events: string[] = [];
    const phases = new ScreenCursorPhases((event) =>
      events.push(`${event.identity.generation}:${event.phase}`),
    );
    phases.hostCallStarted(ref, 1);
    phases.hostCallStarted({ ...ref, generation: 2 }, 2);
    phases.hostCallSettled(ref, 1);
    expect(events).toEqual(["1:thinking", "2:thinking"]);
  });

  it("settles only a cut cell's pending calls with endCell and bumps generation across A -> B -> A", () => {
    const events: string[] = [];
    const phases = new ScreenCursorPhases((event) =>
      events.push(`${event.identity.targetId}:${event.identity.generation}:${event.phase}`),
    );
    const targetA = { ...ref, id: "a", generation: 1 };
    const targetB = { ...ref, id: "b", generation: 2 };
    phases.hostCallStarted(targetA, "c1\u00001");
    phases.endCell(targetA, "c1");
    phases.hostCallSettled(targetA, "c1\u00001");
    phases.hostCallStarted(targetB, "c2\u00001");
    phases.hostCallSettled(targetB, "c2\u00001");
    phases.hostCallStarted(targetA, "c2\u00002");
    expect(phases.generationOf(targetA, "c2\u00002")).toBe(3);
    phases.hostCallSettled(targetA, "c2\u00002");
    expect(events).toEqual([
      "a:1:thinking",
      "a:1:resting",
      "b:2:thinking",
      "b:2:resting",
      "a:3:thinking",
      "a:3:resting",
    ]);
  });
});
