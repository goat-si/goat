// @effect-diagnostics nodeBuiltinImport:off - Runs the Store on node:sqlite in place of Durable Object storage.
// Two device flows for one machine that finish in the same second sign byte-identical assertions;
// recording the second must not fail (the token poll answered 500) and must keep the first's state.
import * as NodeSqlite from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { signingKeyFromSeed } from "@goat/pen-protocol/identity";
import { mint } from "../src/api.ts";
import type { Context, LoginSigner } from "../src/context.ts";
import { type DeviceRow, Store } from "../src/store.ts";

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

describe("minting across a reset", () => {
  async function minting(resetDuring: boolean) {
    const store = new Store(storage());
    const now = 1_794_300_000_000;
    const key = await signingKeyFromSeed(new Uint8Array(32).fill(7));
    let release: (signer: LoginSigner) => void = () => {};
    const gate = new Promise<LoginSigner>((resolve) => (release = resolve));
    const ctx = {
      store,
      now,
      origin: "https://login.example",
      loginKey: () => gate,
    } as unknown as Context;
    const device = { sign_pub: "s", noise_pub: "n", name: "box" } as unknown as DeviceRow;
    const pending = mint(ctx, device, "sub-1", "me@example.com");
    if (resetDuring) store.reset("sub-1", now);
    release({ key, public: { kid: "kid", pub: "pub" } });
    return pending;
  }

  it("an approved poll whose signing a reset of the account overtakes returns no assertion", async () => {
    const res = await minting(true);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ status: "denied" });
  });

  it("without a reset the same poll returns its assertion", async () => {
    const res = await minting(false);
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toHaveProperty("assertion");
  });
});
