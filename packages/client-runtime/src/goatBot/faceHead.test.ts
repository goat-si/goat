import { describe, expect, it } from "vite-plus/test";

import type { GoatBotFaceState } from "./face.ts";
import { goatBotHeadArt } from "./faceHead.ts";

const STATES: ReadonlyArray<GoatBotFaceState> = [
  "idle",
  "reading",
  "working",
  "waiting",
  "failed",
  "finished",
  "sleeping",
];

/** How many separate shapes a path draws: one per move. */
const shapes = (path: string) => (path.match(/M/g) ?? []).length;

describe("goatBotHeadArt: each face state maps to its own eyes", () => {
  it("draws two eyes in every state", () => {
    for (const state of STATES) {
      const art = goatBotHeadArt(state);
      expect(shapes(art.eyes) + shapes(art.strokes), state).toBe(2);
    }
  });

  it("gives the seven states seven different drawings", () => {
    const drawings = new Set(STATES.map((state) => JSON.stringify(goatBotHeadArt(state))));
    expect(drawings.size).toBe(STATES.length);
  });

  it("shows the sleep mark only while sleeping", () => {
    for (const state of STATES)
      expect(goatBotHeadArt(state).sleepMark, state).toBe(state === "sleeping");
  });

  it("keeps one eye open and winks the other while waiting", () => {
    const art = goatBotHeadArt("waiting");
    expect(shapes(art.eyes)).toBe(1);
    expect(shapes(art.strokes)).toBe(1);
  });

  it("closes both eyes into lines when failed, finished or sleeping", () => {
    for (const state of ["failed", "finished", "sleeping"] as const) {
      const art = goatBotHeadArt(state);
      expect(art.eyes, state).toBe("");
      expect(shapes(art.strokes), state).toBe(2);
    }
  });
});
