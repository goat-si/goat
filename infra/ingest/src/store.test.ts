// @effect-diagnostics globalDate:off - Tests drive the Worker's plain Date API with fixed instants.
import { describe, expect, it } from "vite-plus/test";

import { sqliteD1 } from "./sqliteD1.testkit.ts";
import {
  PAGE_SIZE,
  deleteExpired,
  insertBatch,
  rowStorageCost,
  utcDay,
  type BatchRow,
} from "./store.ts";

const DAY_MS = 86_400_000;
const BUDGET = { batches: 20_000, bytes: 2_400_000 };
const row = (day: string, batchId: string, json = '{"events":[]}'): BatchRow => ({
  day,
  batchId,
  eventCount: 1,
  json,
  cost: rowStorageCost(json.length),
});
const id = (n: number) => n.toString(16).padStart(64, "0");

/** Inserts batches whose JSON is `size` bytes until the day's budget refuses one. */
async function fillDay(
  store: ReturnType<typeof sqliteD1>,
  day: string,
  sizes: () => number,
  budget = BUDGET,
): Promise<number> {
  let charged = 0;
  for (let n = 0; ; n += 1) {
    const json = "x".repeat(sizes());
    const next = row(day, id(n), json);
    if ((await insertBatch(store.db, next, budget)) === "over_budget") return charged;
    charged += next.cost;
  }
}

describe("insertBatch", () => {
  it("stores an exact retry once per UTC day, and stores a retry that crosses midnight again", async () => {
    const store = sqliteD1();
    expect(await insertBatch(store.db, row("2026-10-25", id(1)), BUDGET)).toBe("stored");
    expect(await insertBatch(store.db, row("2026-10-25", id(1)), BUDGET)).toBe("duplicate");
    expect(await insertBatch(store.db, row("2026-10-26", id(1)), BUDGET)).toBe("stored");
    expect(store.rows().map((stored) => stored.day)).toEqual(["2026-10-25", "2026-10-26"]);
  });

  it("refuses past the daily budget, including a day's first batch, and stores nothing it refused", async () => {
    const store = sqliteD1();
    const cost = rowStorageCost(13);
    expect(
      await insertBatch(store.db, row("2026-10-25", id(1)), { batches: 1, bytes: cost - 1 }),
    ).toBe("over_budget");
    expect(store.usage("2026-10-25")).toBeUndefined();

    expect(await insertBatch(store.db, row("2026-10-25", id(1)), { batches: 1, bytes: cost })).toBe(
      "stored",
    );
    expect(await insertBatch(store.db, row("2026-10-25", id(2)), { batches: 1, bytes: cost })).toBe(
      "over_budget",
    );
    expect(await insertBatch(store.db, row("2026-10-26", id(2)), { batches: 1, bytes: cost })).toBe(
      "stored",
    );
    expect(store.rows()).toHaveLength(2);
    expect(store.usage("2026-10-25")).toEqual({ batches: 1, bytes: cost });
  });

  it("lets only one of two concurrent requests take the last budget slot", async () => {
    const store = sqliteD1();
    const budget = { batches: 1, bytes: BUDGET.bytes };
    const outcomes = await Promise.all([
      insertBatch(store.db, row("2026-10-25", id(1)), budget),
      insertBatch(store.db, row("2026-10-25", id(2)), budget),
    ]);
    expect(outcomes.toSorted()).toEqual(["over_budget", "stored"]);
    expect(store.rows()).toHaveLength(1);
  });
});

describe("storage", () => {
  it("charges at least the storage SQLite uses for every batch size, including overflow boundaries", async () => {
    const sizes = new Set<number>([997]);
    for (let size = 150; size <= 6_000; size += 16) sizes.add(size);
    for (let size = 6_000; size <= 131_072; size += 512) sizes.add(size);
    // The record sizes where a cell starts spilling, and each further overflow page.
    for (let pages = 0; pages <= 32; pages += 1) {
      for (const delta of [-1, 0, 1]) sizes.add(1_002 - 114 + pages * (PAGE_SIZE - 4) + delta);
    }
    const tooLow: Array<{ size: number; used: number; charged: number }> = [];
    for (const size of sizes) {
      const store = sqliteD1();
      const empty = store.fileBytes();
      const charged = await fillDay(store, "2026-10-25", () => size, {
        batches: 20_000,
        bytes: 600_000,
      });
      const used = store.fileBytes() - empty;
      if (used > charged) tooLow.push({ size, used, charged });
    }
    expect(tooLow).toEqual([]);
  });

  it("keeps the file within the retained days' budgets through mixed traffic and retention turnover", async () => {
    const store = sqliteD1();
    const budget = { batches: 20_000, bytes: 400_000 };
    const empty = store.fileBytes();
    let seed = 7;
    // Small rows, rows past the spill size and multi-page rows, in a fixed pseudorandom mix.
    const size = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return [180, 400, 960, 1_100, 3_000, 9_000, 40_000][seed % 7] ?? 180;
    };
    const start = Date.UTC(2026, 0, 1);
    // A 3-day retention keeps today and yesterday (retentionCutoffDay keeps retentionDays - 2 back).
    for (let day = 0; day < 12; day += 1) {
      const now = new Date(start + day * DAY_MS);
      await fillDay(store, utcDay(now), size, budget);
      await deleteExpired(store.db, now, 3);
      expect(store.fileBytes() - empty).toBeLessThanOrEqual(3 * budget.bytes);
    }
  });

  it("refuses a batch at the database size limit without a partial write, and resumes after retention", async () => {
    const store = sqliteD1();
    await fillDay(store, "2026-04-01", () => 3_000);
    store.limitPages(store.pageCount() + 8);
    let failure: unknown;
    for (let n = 0; ; n += 1) {
      const outcome = await insertBatch(
        store.db,
        row("2026-10-25", id(n), "y".repeat(3_000)),
        BUDGET,
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      if (outcome !== undefined) {
        failure = outcome;
        break;
      }
    }
    expect(String(failure)).toMatch(/full/);
    const stored = store.rows().filter((stored) => stored.day === "2026-10-25").length;
    expect(store.usage("2026-10-25")?.batches).toBe(stored);

    await deleteExpired(store.db, new Date("2026-10-25T00:17:00Z"), 180);
    const limit = store.pageCount();
    expect(
      await insertBatch(store.db, row("2026-10-25", id(99_999), "y".repeat(3_000)), BUDGET),
    ).toBe("stored");
    expect(store.pageCount()).toBeLessThanOrEqual(limit);
  });
});

describe("deleteExpired", () => {
  it("deletes a batch before it is 180 days old, even after three missed cleanup runs", async () => {
    const receivedAt = Date.UTC(2026, 3, 29, 0, 0, 0);
    const store = sqliteD1();
    await insertBatch(store.db, row(utcDay(new Date(receivedAt)), id(1)), BUDGET);
    await insertBatch(store.db, row(utcDay(new Date(receivedAt + DAY_MS)), id(2)), BUDGET);

    // Cleanup runs at :17 every 6 hours; find the first run that deletes the first batch.
    let run = Date.UTC(2026, 3, 29, 0, 17);
    while (store.rows().length === 2) {
      run += 6 * 3_600_000;
      await deleteExpired(store.db, new Date(run), 180);
    }
    expect(run - receivedAt).toBeGreaterThan(178 * DAY_MS);
    expect(run + 3 * 6 * 3_600_000 - receivedAt).toBeLessThan(180 * DAY_MS);
    expect(store.rows().map((stored) => stored.day)).toEqual(["2026-04-30"]);
    expect(store.usage("2026-04-29")).toBeUndefined();
  });

  it("catches up on every expired day when runs were missed", async () => {
    const store = sqliteD1();
    for (const [n, day] of ["2026-03-01", "2026-04-01", "2026-04-29", "2026-04-30"].entries()) {
      await insertBatch(store.db, row(day, id(n)), BUDGET);
    }
    await deleteExpired(store.db, new Date("2026-10-25T00:17:00Z"), 180);
    expect(store.rows().map((stored) => stored.day)).toEqual(["2026-04-30"]);
  });
});
