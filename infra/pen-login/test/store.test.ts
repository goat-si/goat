// @effect-diagnostics nodeBuiltinImport:off - Runs the Store on node:sqlite in place of Durable Object storage.
// Two device flows for one machine that finish in the same second sign byte-identical assertions;
// recording the second must not fail (the token poll answered 500) and must keep the first's state.
import * as NodeSqlite from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { signingKeyFromSeed } from "@goat/pen-protocol/identity";
import { mint } from "../src/api.ts";
import type { Context, LoginSigner } from "../src/context.ts";
import { type DeviceRow, Store } from "../src/store.ts";
import { storage } from "./storage.ts";

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

// The schema of the pen-login version deployed before 0.2.7 (commit 26cb3a74ef7e), with rows it wrote.
const SCHEMA_26CB3A74EF = [
  `CREATE TABLE IF NOT EXISTS devices (
    code_hash TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE, sign_pub TEXT NOT NULL, noise_pub TEXT NOT NULL,
    name TEXT NOT NULL, country TEXT NOT NULL, city TEXT NOT NULL, created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, last_poll_at INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
    sub TEXT, email TEXT, source TEXT NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS devices_by_source ON devices (source, expires_at)",
  "CREATE INDEX IF NOT EXISTS devices_by_sub ON devices (sub, status)",
  `CREATE TABLE IF NOT EXISTS web_sessions (
    id_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, source TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT '',
    user_code TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '', verifier TEXT NOT NULL DEFAULT '',
    nonce TEXT NOT NULL DEFAULT '', csrf TEXT NOT NULL DEFAULT '', sub TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '')`,
  "CREATE INDEX IF NOT EXISTS sessions_by_source ON web_sessions (source, expires_at)",
  "CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS lockouts (source TEXT PRIMARY KEY, wrong INTEGER NOT NULL, first_at INTEGER NOT NULL, locked_until INTEGER NOT NULL)",
  `CREATE TABLE IF NOT EXISTS assertions (
    hash TEXT PRIMARY KEY, sub TEXT NOT NULL, name TEXT NOT NULL, exp INTEGER NOT NULL, issued_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0)`,
  "CREATE INDEX IF NOT EXISTS assertions_by_sub ON assertions (sub, used)",
  "CREATE TABLE IF NOT EXISTS accounts (sub TEXT PRIMARY KEY, mesh_id TEXT NOT NULL, created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS resets (sub TEXT PRIMARY KEY, at INTEGER NOT NULL)",
  `CREATE TABLE IF NOT EXISTS nodes (
    node_id TEXT PRIMARY KEY, sub TEXT NOT NULL, sign_pub TEXT NOT NULL, noise_pub TEXT NOT NULL, name TEXT NOT NULL,
    registered_at INTEGER NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS nodes_by_sub ON nodes (sub, registered_at)",
  "CREATE TABLE IF NOT EXISTS jwks (url TEXT PRIMARY KEY, body TEXT NOT NULL, fetched_at INTEGER NOT NULL)",
];

describe("opening the data an older version wrote", () => {
  it("keeps a row in each of the nine 26cb3a74ef tables, adds started_at, and starts the reset stamp from the old resets", () => {
    const db = new NodeSqlite.DatabaseSync(":memory:");
    for (const statement of SCHEMA_26CB3A74EF) db.exec(statement);
    const now = 1_794_300_000_000;
    db.prepare(
      `INSERT INTO devices (code_hash, user_code, sign_pub, noise_pub, name, country, city, created_at, expires_at, status, sub, email, source)
       VALUES ('h1', 'ABCD2345', 's1', 'n1', 'box', 'KR', 'Seoul', ?, ?, 'pending', NULL, NULL, 'src')`,
    ).run(now, now + 600_000);
    db.prepare(
      "INSERT INTO web_sessions (id_hash, expires_at, source, purpose, user_code, sub, email) VALUES ('w1', ?, 'src', 'device', 'ABCD2345', 'sub-1', 'me@example.com')",
    ).run(now + 3_600_000);
    db.prepare(
      "INSERT INTO assertions (hash, sub, name, exp, issued_at) VALUES ('a1', 'sub-1', 'box', ?, ?)",
    ).run(now / 1000 + 600, now - 1);
    db.prepare("INSERT INTO accounts (sub, mesh_id, created_at) VALUES ('sub-1', 'mesh-1', ?)").run(
      now,
    );
    db.prepare("INSERT INTO resets (sub, at) VALUES ('sub-2', ?)").run(now - 5);
    db.prepare(
      "INSERT INTO nodes (node_id, sub, sign_pub, noise_pub, name, registered_at) VALUES ('node-1', 'sub-1', 's0', 'n0', 'hub', ?)",
    ).run(now);
    db.prepare("INSERT INTO counters (key, window, count) VALUES ('page:src', ?, 3)").run(
      Math.floor(now / 60_000),
    );
    db.prepare(
      "INSERT INTO lockouts (source, wrong, first_at, locked_until) VALUES ('src-2', 5, ?, ?)",
    ).run(now - 1_000, now + 500_000);
    db.prepare(
      "INSERT INTO jwks (url, body, fetched_at) VALUES ('https://issuer.example/jwks', '{\"keys\":[]}', ?)",
    ).run(now - 2_000);

    // The old object never wrote the KV key "stamp"; storage(db) starts with an empty KV, as it does.
    const store = new Store(storage(db));

    // The rate-limit counter of this minute continues, a lockout still in force holds and counts on,
    // and the cached JWKS entry reads back.
    expect(store.hit("page:src", now)).toBe(4);
    expect(store.lockedUntil("src-2")).toBe(now + 500_000);
    expect(store.recordWrongCode("src-2", now)).toBe(0);
    expect(store.jwks("https://issuer.example/jwks")).toEqual({
      body: '{"keys":[]}',
      fetched_at: now - 2_000,
    });

    expect(store.deviceByUserCode("ABCD2345")?.status).toBe("pending");
    const session = store.session("w1", now);
    expect([session?.sub, session?.user_code, session?.started_at]).toEqual([
      "sub-1",
      "ABCD2345",
      0,
    ]);
    expect(store.meshOf("sub-1")).toBe("mesh-1");
    expect(store.nodesOf("sub-1").map((node) => node.node_id)).toEqual(["node-1"]);
    expect([store.resetAt("sub-2"), store.resetAt("sub-1")]).toEqual([now - 5, 0]);
    expect(
      store.register(
        {
          hash: "a1",
          sub: "sub-1",
          meshId: "mesh-1",
          nodeId: "node-2",
          signPub: "s1",
          noisePub: "n1",
        },
        now,
      ),
    ).toEqual({ ok: true });
    // A session written before the upgrade has started_at 0, so it counts as older than any reset,
    // including none (resetAt 0): web.ts refuses that one sign-in in flight across the upgrade.
    expect(session?.started_at ?? -1).toBeLessThanOrEqual(store.resetAt("sub-1"));
    // With no stamp in KV yet, the first reset stamps at its own time, later than every old reset
    // and every old assertion; a sign-in started after it stamps later still.
    store.reset("sub-1", now + 1);
    expect(store.resetAt("sub-1")).toBe(now + 1);
    expect(store.stamp(now + 1)).toBe(now + 2);
    expect(store.session("w1", now)?.sub).toBe("");
    expect(store.deviceByUserCode("ABCD2345")?.status).toBe("denied");
    expect(store.meshOf("sub-1")).toBeNull();
  });
});
