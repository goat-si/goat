// @effect-diagnostics nodeBuiltinImport:off - Runs the Store on node:sqlite in place of Durable Object storage.
// Two device flows for one machine that finish in the same second sign byte-identical assertions;
// recording the second must not fail (the token poll answered 500) and must keep the first's state.
import * as NodeSqlite from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { Store } from "../src/store.ts";

function storage(): DurableObjectStorage {
  const db = new NodeSqlite.DatabaseSync(":memory:");
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
  return {
    sql,
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

describe("assertion records", () => {
  it("records a second identical assertion without failing and keeps the first one's state", () => {
    const store = new Store(storage());
    const now = 1_794_300_000_000;
    store.insertAssertion("hash-a", "1001", "laptop", 1_794_300_600, now);
    const first = store.register(
      {
        hash: "hash-a",
        sub: "1001",
        meshId: "mesh1",
        nodeId: "node1",
        signPub: "s",
        noisePub: "n",
      },
      now,
    );
    expect(first.ok).toBe(true);
    expect(() =>
      store.insertAssertion("hash-a", "1001", "laptop", 1_794_300_600, now),
    ).not.toThrow();
    const again = store.register(
      {
        hash: "hash-a",
        sub: "1001",
        meshId: "mesh1",
        nodeId: "node1",
        signPub: "s",
        noisePub: "n",
      },
      now,
    );
    expect(again).toEqual({ ok: false, error: "assertion_used" });
  });
});
