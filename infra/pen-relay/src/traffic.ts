/**
 * Per-node byte totals: each Room keeps one row for its node, written at most once a minute. Bytes
 * not written yet ride in socket attachments, which survive hibernation.
 */
export const TOTALS_WRITE_EVERY_MS = 60_000;

export interface Counts {
  readonly toNode: number;
  readonly fromNode: number;
  /** Sessions the node answered, and sessions that ended before it answered. */
  readonly sessions: number;
  readonly unanswered: number;
}

export interface Totals extends Counts {
  /** First and latest write, in ms since epoch. */
  readonly since: number;
  readonly at: number;
}

export const NO_COUNTS: Counts = { toNode: 0, fromNode: 0, sessions: 0, unanswered: 0 };

export function addCounts(a: Counts, b: Counts): Counts {
  return {
    toNode: a.toNode + b.toNode,
    fromNode: a.fromNode + b.fromNode,
    sessions: a.sessions + b.sessions,
    unanswered: a.unanswered + b.unanswered,
  };
}

export function isEmpty(c: Counts): boolean {
  return c.toNode === 0 && c.fromNode === 0 && c.sessions === 0 && c.unanswered === 0;
}

export interface TotalsStore {
  read(): Totals | null;
  write(totals: Totals): void;
}

/** When the next write may happen. */
export function writableAt(stored: Totals | null, everyMs: number): number {
  return stored === null ? 0 : stored.at + everyMs;
}

/** Adds pending to the stored totals when a write is allowed at now; returns what stays pending. */
export function flushTotals(
  store: TotalsStore,
  pending: Counts,
  now: number,
  everyMs: number = TOTALS_WRITE_EVERY_MS,
): Counts {
  if (isEmpty(pending)) return NO_COUNTS;
  const stored = store.read();
  if (now < writableAt(stored, everyMs)) return pending;
  store.write({ ...addCounts(stored ?? NO_COUNTS, pending), since: stored?.since ?? now, at: now });
  return NO_COUNTS;
}

/**
 * One row in the Room's SQLite database, readable in the dashboard's Data Studio. Only a write
 * creates the table: a Room that never carried a session keeps nothing.
 */
export function sqlTotalsStore(sql: SqlStorage): TotalsStore {
  let cached: Totals | null | undefined;
  return {
    read() {
      if (cached !== undefined) return cached;
      const exists = sql
        .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'traffic'")
        .toArray();
      if (exists.length === 0) {
        cached = null;
        return cached;
      }
      const row = sql
        .exec<{
          to_node: number;
          from_node: number;
          sessions: number;
          unanswered: number;
          since: number;
          at: number;
        }>("SELECT to_node, from_node, sessions, unanswered, since, at FROM traffic WHERE id = 1")
        .toArray()[0];
      cached = row
        ? {
            toNode: row.to_node,
            fromNode: row.from_node,
            sessions: row.sessions,
            unanswered: row.unanswered,
            since: row.since,
            at: row.at,
          }
        : null;
      return cached;
    },
    write(totals) {
      sql.exec(
        "CREATE TABLE IF NOT EXISTS traffic (id INTEGER PRIMARY KEY CHECK (id = 1), to_node INTEGER NOT NULL, from_node INTEGER NOT NULL, sessions INTEGER NOT NULL, unanswered INTEGER NOT NULL, since INTEGER NOT NULL, at INTEGER NOT NULL)",
      );
      sql.exec(
        "INSERT INTO traffic (id, to_node, from_node, sessions, unanswered, since, at) VALUES (1, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET to_node = excluded.to_node, from_node = excluded.from_node, sessions = excluded.sessions, unanswered = excluded.unanswered, since = excluded.since, at = excluded.at",
        totals.toNode,
        totals.fromNode,
        totals.sessions,
        totals.unanswered,
        totals.since,
        totals.at,
      );
      cached = totals;
    },
  };
}
