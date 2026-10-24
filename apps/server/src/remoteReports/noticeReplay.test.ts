import { describe, expect, it } from "vite-plus/test";

import {
  overnightPullRequestStream,
  overnightNoticeStream,
  replayNoticeDigest,
  replayNoticeStream,
  replayPullRequestDigest,
} from "./noticeReplay.testkit.ts";

/**
 * Per-turn notice bytes for the synthetic 30-lane night. On dev before the compaction this
 * stream injected 143,215 B over 33 turns (mean 4,340 B, largest 4,702 B). The budget sits a
 * little above the current figures, so growth is a decision rather than drift.
 */
const MEAN_TURN_BUDGET_BYTES = 3_328;
const LARGEST_TURN_BUDGET_BYTES = 3_584;

describe("notice replay", () => {
  it("keeps a 30-lane overnight stream within the per-turn notice budget", () => {
    const turns = replayNoticeStream(overnightNoticeStream());
    const total = turns.reduce((sum, bytes) => sum + bytes, 0);
    expect(total / turns.length).toBeLessThanOrEqual(MEAN_TURN_BUDGET_BYTES);
    expect(Math.max(...turns)).toBeLessThanOrEqual(LARGEST_TURN_BUDGET_BYTES);
  });

  it("delivers each lane's result once and folds notices that wait for a busy thread", () => {
    const total = (turns: ReadonlyArray<number>) => turns.reduce((sum, bytes) => sum + bytes, 0);
    const events = overnightNoticeStream();
    // Idle supervisor: one turn per wake as before, but a run end no longer repeats its report.
    const idle = replayNoticeDigest(events, 1);
    expect(idle).toHaveLength(33);
    expect(total(idle)).toBeLessThanOrEqual(88_000);
    // Busy for eight events per turn: wakes that arrive meanwhile share one turn.
    const busy = replayNoticeDigest(events, 8);
    expect(busy.length).toBeLessThanOrEqual(20);
    expect(total(busy)).toBeLessThanOrEqual(94_000);
  });

  it("tells every pull request's kept context once, within the night's budget (#1055)", () => {
    // Before #1055 this night told 12 of its 67 kept updates (108,705 B over 31 turns, busy for
    // eight events) and ended with all 30 pull requests holding context nobody was told.
    const { turns, untold } = replayPullRequestDigest(overnightPullRequestStream(), 8);
    expect(untold).toBe(0);
    expect(turns.length).toBeLessThanOrEqual(31);
    expect(turns.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual(122_000);
  });
});
