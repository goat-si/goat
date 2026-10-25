// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PAGE_SIZE, type IngestDatabase } from "./store.ts";

interface Statement {
  readonly sql: string;
  readonly values: ReadonlyArray<string | number>;
}

const MIGRATIONS = NodePath.join(import.meta.dirname, "../migrations");

/**
 * D1's statement and batch API over an in-memory node:sqlite database with the real
 * migrations applied. A batch runs as one transaction, as D1 runs it. `limitPages` caps
 * the file the way D1's per-database size limit does.
 */
export function sqliteD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`PRAGMA page_size = ${PAGE_SIZE}`);
  for (const file of NodeFS.readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    sqlite.exec(NodeFS.readFileSync(NodePath.join(MIGRATIONS, file), "utf8"));
  }
  const pageCount = () => Number(sqlite.prepare("PRAGMA page_count").get()?.page_count);
  const db: IngestDatabase<Statement> = {
    prepare: (sql) => ({ bind: (...values) => ({ sql, values }) }),
    batch: async (statements) => {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map(({ sql, values }) => ({
          meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) },
        }));
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return {
    db,
    fileBytes: () => pageCount() * PAGE_SIZE,
    limitPages: (pages: number) => sqlite.exec(`PRAGMA max_page_count = ${pages}`),
    pageCount,
    rows: () =>
      sqlite
        .prepare(
          "SELECT received_day, event_count, events FROM batches ORDER BY received_day, batch_id",
        )
        .all()
        .map((row) => ({
          day: String(row.received_day),
          eventCount: Number(row.event_count),
          events: String(row.events),
        })),
    usage: (day: string) => {
      const row = sqlite.prepare("SELECT batches, bytes FROM daily_usage WHERE day = ?").get(day);
      return row === undefined
        ? undefined
        : { batches: Number(row.batches), bytes: Number(row.bytes) };
    },
  };
}
