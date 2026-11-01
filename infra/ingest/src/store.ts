// @effect-diagnostics globalDate:off - A plain Cloudflare Worker with no Effect runtime.
const DAY_MS = 86_400_000;

/** D1 pages are SQLite's default 4096 bytes; the deploy runbook checks it. */
export const PAGE_SIZE = 4096;
// A WITHOUT ROWID table is an index b-tree. Cells larger than MAX_LOCAL keep a local
// part and spill the rest into whole overflow pages (sqlite.org/fileformat.html, b-tree pages).
const MAX_LOCAL = Math.floor(((PAGE_SIZE - 12) * 64) / 255) - 23;
const MIN_LOCAL = Math.floor(((PAGE_SIZE - 12) * 32) / 255) - 23;
// The 64-hex batch id, the day, event_count, and the record header, with margin.
const RECORD_OVERHEAD = 64 + 10 + 8 + 32;
// Interior pages and the cell pointer, per row.
const ROW_ALLOWANCE = 512;
// Balancing keeps pages that are not the root at least about a third full.
const OCCUPANCY_FACTOR = 3;

/**
 * Storage a row can take, counted against the daily budget. It covers the local cell
 * at the lowest page occupancy plus every overflow page in full, so a batch just past
 * the spill size is charged for the 4 KB overflow page it occupies.
 */
export function rowStorageCost(jsonBytes: number): number {
  const payload = jsonBytes + RECORD_OVERHEAD;
  if (payload <= MAX_LOCAL) return OCCUPANCY_FACTOR * (payload + 8) + ROW_ALLOWANCE;
  const spill = MIN_LOCAL + ((payload - MIN_LOCAL) % (PAGE_SIZE - 4));
  const local = spill <= MAX_LOCAL ? spill : MIN_LOCAL;
  const overflowPages = Math.ceil((payload - local) / (PAGE_SIZE - 4));
  return OCCUPANCY_FACTOR * (local + 12) + overflowPages * PAGE_SIZE + ROW_ALLOWANCE;
}

/** The parts of a D1 database the ingest uses. D1Database satisfies it. */
export interface IngestDatabase<Statement> {
  prepare(query: string): { bind(...values: Array<string | number>): Statement };
  batch(
    statements: Array<Statement>,
  ): Promise<ReadonlyArray<{ readonly meta: { readonly changes: number } }>>;
}

export interface DailyBudget {
  readonly batches: number;
  readonly bytes: number;
}

export interface BatchRow {
  readonly day: string;
  readonly batchId: string;
  readonly eventCount: number;
  readonly json: string;
  readonly cost: number;
}

export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

// The guarded INSERT covers a day's first batch; the DO UPDATE ... WHERE only applies
// on conflict, so both parts check the budget.
const ADMIT = `INSERT INTO daily_usage (day, batches, bytes)
SELECT ?1, 1, ?2 WHERE 1 <= ?3 AND ?2 <= ?4
ON CONFLICT (day) DO UPDATE SET batches = batches + 1, bytes = bytes + excluded.bytes
WHERE batches + 1 <= ?3 AND bytes + excluded.bytes <= ?4`;
// changes() is the row count of the statement before it in this transaction: the
// admission above. A refused admission therefore inserts nothing.
const INSERT = `INSERT OR IGNORE INTO batches (received_day, batch_id, event_count, events)
SELECT ?1, ?2, ?3, ?4 WHERE changes() = 1`;

export type InsertOutcome = "stored" | "duplicate" | "over_budget";

/**
 * Admits and stores one batch in a single D1 batch, which D1 runs as one transaction
 * serialized per database, so concurrent requests cannot both pass the last budget
 * slot. A D1 error, including "Exceeded maximum DB size.", rolls back both statements.
 */
export async function insertBatch<Statement>(
  db: IngestDatabase<Statement>,
  row: BatchRow,
  budget: DailyBudget,
): Promise<InsertOutcome> {
  const [admitted, inserted] = await db.batch([
    db.prepare(ADMIT).bind(row.day, row.cost, budget.batches, budget.bytes),
    db.prepare(INSERT).bind(row.day, row.batchId, row.eventCount, row.json),
  ]);
  if (admitted?.meta.changes !== 1) return "over_budget";
  return inserted?.meta.changes === 1 ? "stored" : "duplicate";
}

/**
 * The oldest day retention keeps. With cleanup every 6 hours, a row is deleted 178 to
 * 179 days after it arrived, and three missed runs in a row still stay under
 * `retentionDays` (180).
 */
export const retentionCutoffDay = (now: Date, retentionDays: number): string =>
  utcDay(new Date(now.getTime() - (retentionDays - 2) * DAY_MS));

/**
 * Deletes every day before the cutoff, so a missed run is caught up by the next one.
 * Freed pages go to SQLite's freelist and later inserts reuse them, which is how
 * ingestion recovers after the database reaches D1's size limit.
 */
export async function deleteExpired<Statement>(
  db: IngestDatabase<Statement>,
  now: Date,
  retentionDays: number,
): Promise<void> {
  const cutoff = retentionCutoffDay(now, retentionDays);
  await db.batch([
    db.prepare("DELETE FROM batches WHERE received_day < ?1").bind(cutoff),
    db.prepare("DELETE FROM daily_usage WHERE day < ?1").bind(cutoff),
  ]);
}
