import { EnvironmentId } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";

import { reduceBrowserPointer } from "./browserPointerStore";

const identity = {
  environmentId: EnvironmentId.make("environment"),
  runId: "run-1",
  turnId: "turn-1",
  targetId: "target",
  generation: 1,
};
const state = { byTabId: {}, ownerByTabId: {}, detached: new Set<string>() };

describe("browser pointer ownership", () => {
  it("late previous-run pointer cannot resurrect a cleared tab", () => {
    const shown = reduceBrowserPointer(state, {
      tabId: "runtime-tab",
      phase: "move",
      x: 10,
      y: 20,
      sequence: 1,
      createdAt: "now",
      cursor: { identity: { ...identity, sequence: 1 }, phase: "moving" },
    });
    const hidden = reduceBrowserPointer(shown, {
      type: "cursor-state",
      tabId: "runtime-tab",
      sequence: 2,
      createdAt: "later",
      cursor: { identity: { ...identity, sequence: 2 }, phase: "hidden" },
    });
    expect(hidden.byTabId).toEqual({});
    expect(
      reduceBrowserPointer(hidden, {
        tabId: "runtime-tab",
        phase: "move",
        x: 10,
        y: 20,
        sequence: 3,
        createdAt: "latest-clock",
        cursor: { identity: { ...identity, sequence: 1 }, phase: "moving" },
      }),
    ).toBe(hidden);
    const nextRun = reduceBrowserPointer(hidden, {
      tabId: "runtime-tab",
      phase: "move",
      x: 30,
      y: 40,
      sequence: 5,
      createdAt: "next-run",
      cursor: {
        identity: { ...identity, runId: "run-2", sequence: 1 },
        phase: "moving",
      },
    });
    expect(nextRun.byTabId["runtime-tab"]?.x).toBe(30);
    expect(
      reduceBrowserPointer(nextRun, {
        tabId: "runtime-tab",
        phase: "move",
        x: 10,
        y: 20,
        sequence: 6,
        createdAt: "old-run",
        cursor: {
          identity: { ...identity, sequence: 3 },
          phase: "moving",
        },
      }),
    ).toBe(nextRun);
    expect(
      reduceBrowserPointer(hidden, {
        tabId: "runtime-tab",
        phase: "click",
        x: 12,
        y: 22,
        sequence: 4,
        createdAt: "legacy",
      }).byTabId["runtime-tab"]?.phase,
    ).toBe("click");
  });

  it("keeps the current owner on a same-sequence code pointer", () => {
    const cursor = { identity: { ...identity, sequence: 1 }, phase: "thinking" as const };
    const owned = reduceBrowserPointer(state, {
      type: "cursor-state",
      tabId: "runtime-tab",
      sequence: 1,
      createdAt: "now",
      cursor,
    });
    const pointed = reduceBrowserPointer(owned, {
      tabId: "runtime-tab",
      phase: "move",
      x: 10,
      y: 20,
      sequence: 2,
      createdAt: "later",
      cursor,
    });
    expect(pointed.byTabId["runtime-tab"]?.cursor).toEqual(cursor);
  });
});
