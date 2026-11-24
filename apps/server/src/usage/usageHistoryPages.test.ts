import { describe, expect, it } from "@effect/vitest";

import type { UsageContribution } from "./usageAggregation.ts";
import { UsageHistoryPages } from "./usageHistoryPages.ts";

function contribution(id: number): UsageContribution {
  return {
    bucketId: id,
    record: {
      provider: "claude",
      timestampMs: 1_786_000_000_000,
      model: "claude-fable-5",
      sessionId: "session-a",
      totals: {
        uncachedInputTokens: 2,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 5,
        reasoningTokens: 0,
      },
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: `turn-${id}`,
    },
  };
}

describe("usage contribution spool", () => {
  it("preserves scan isolation, updates and insertion order across spill batches", () => {
    const pages = new UsageHistoryPages();
    try {
      const scan = pages.contributions();
      const otherScan = pages.contributions();
      const count = 14_000;
      for (let i = 0; i < count; i++) scan.set(`turn-${i}`, contribution(i));

      const first = contribution(-1);
      const last = contribution(-2);
      scan.set("turn-0", first);
      scan.set(`turn-${count - 1}`, last);
      otherScan.set("turn-0", contribution(10));
      expect(scan.get("turn-0")).toEqual(first);
      expect(scan.get(`turn-${count - 1}`)).toEqual(last);
      expect(otherScan.get("turn-0")).toEqual(contribution(10));
      expect(Array.from(scan.values(), ({ bucketId }) => bucketId)).toEqual(
        Array.from({ length: count }, (_, i) => (i === 0 ? -1 : i === count - 1 ? -2 : i)),
      );

      scan.set("discarded", contribution(-3));
      scan.clear();
      expect(Array.from(scan.values())).toEqual([]);
      expect(scan.get("turn-0")).toBeUndefined();
      expect(otherScan.get("turn-0")).toEqual(contribution(10));
      scan.set("turn-0", contribution(5));
      expect(scan.get("turn-0")).toEqual(contribution(5));
    } finally {
      pages.close();
    }
  });
});
