import { describe, expect, it } from "vite-plus/test";
import {
  addCounts,
  type Counts,
  flushTotals,
  NO_COUNTS,
  type Totals,
  TOTALS_WRITE_EVERY_MS,
  type TotalsStore,
} from "../src/traffic.ts";

function memoryStore() {
  let row: Totals | null = null;
  const writes: Array<number> = [];
  const store: TotalsStore = {
    read: () => row,
    write: (totals) => {
      row = totals;
      writes.push(totals.at);
    },
  };
  return { store, writes, row: () => row };
}

const oneSession: Counts = { toNode: 7, fromNode: 11, sessions: 1, unanswered: 0 };
const START = 1_794_000_000_000;

describe("Room totals (injected clock)", () => {
  it("are written at most once a minute however often sessions end, and lose nothing", () => {
    const { store, writes, row } = memoryStore();
    let pending = NO_COUNTS;
    let ended = 0;
    for (let now = START; now < START + 10 * TOTALS_WRITE_EVERY_MS; now += 250) {
      pending = flushTotals(store, addCounts(pending, oneSession), now);
      ended++;
    }
    expect(writes.length).toBe(10);
    for (let i = 1; i < writes.length; i++) {
      expect(writes[i]! - writes[i - 1]!).toBeGreaterThanOrEqual(TOTALS_WRITE_EVERY_MS);
    }
    const total = addCounts(row() ?? NO_COUNTS, pending);
    expect(total).toEqual({
      toNode: 7 * ended,
      fromNode: 11 * ended,
      sessions: ended,
      unanswered: 0,
    });
    expect(row()?.since).toBe(START);
  });

  it("survive a restart with every byte up to the last write, at most one minute behind", () => {
    const { store, row } = memoryStore();
    let pending = NO_COUNTS;
    let ended = 0;
    let now = START;
    for (; now < START + 3.5 * TOTALS_WRITE_EVERY_MS; now += 1000) {
      pending = flushTotals(store, addCounts(pending, oneSession), now);
      ended++;
    }
    // A restart drops the instance and keeps only the stored row.
    const kept = row();
    expect(kept).not.toBeNull();
    const lost = ended - kept!.sessions;
    expect(lost).toBe(pending.sessions);
    expect(now - kept!.at).toBeLessThanOrEqual(TOTALS_WRITE_EVERY_MS);
    expect(lost).toBeLessThanOrEqual(TOTALS_WRITE_EVERY_MS / 1000);
    const left = flushTotals(store, oneSession, kept!.at + TOTALS_WRITE_EVERY_MS);
    expect(left).toEqual(NO_COUNTS);
    expect(row()).toEqual({
      ...addCounts(kept!, oneSession),
      since: START,
      at: kept!.at + TOTALS_WRITE_EVERY_MS,
    });
  });

  it("never write when nothing is pending", () => {
    const { store, writes } = memoryStore();
    for (let now = START; now < START + 5 * TOTALS_WRITE_EVERY_MS; now += 10_000) {
      expect(flushTotals(store, NO_COUNTS, now)).toEqual(NO_COUNTS);
    }
    expect(writes).toEqual([]);
  });
});
