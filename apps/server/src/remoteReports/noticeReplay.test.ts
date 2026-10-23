import { describe, expect, it } from "vite-plus/test";

import { overnightNoticeStream, replayNoticeStream } from "./noticeReplay.testkit.ts";

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
});
