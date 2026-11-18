// @effect-diagnostics nodeBuiltinImport:off - Runs the Store on node:sqlite in place of Durable Object storage.
import * as NodeSqlite from "node:sqlite";

/** Durable Object storage backed by node:sqlite: sql, kv and transactionSync, as the Store uses them. */
export function storage(db = new NodeSqlite.DatabaseSync(":memory:")): DurableObjectStorage {
  const sql = {
    exec(query: string, ...params: Array<string | number | null>) {
      const st = db.prepare(query);
      if (/^\s*(select|pragma)/i.test(query) || /returning/i.test(query)) {
        const rows = st.all(...params);
        return { toArray: () => rows, rowsWritten: 0 };
      }
      const r = st.run(...params);
      return { toArray: () => [], rowsWritten: Number(r.changes) };
    },
  };
  const kv = new Map<string, unknown>();
  return {
    sql,
    kv: { get: (k: string) => kv.get(k), put: (k: string, v: unknown) => void kv.set(k, v) },
    transactionSync<T>(fn: () => T): T {
      db.exec("BEGIN");
      try {
        const v = fn();
        db.exec("COMMIT");
        return v;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as DurableObjectStorage;
}
