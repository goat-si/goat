import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Disposable machines, one row per attach (design: V1 disposable machines, section 1). A record
 * holds its keys, invite and mint unique only until it reaches a final state (final_at set); the
 * sshd pin, environment, install and link ids are compared by the class rules instead, because two
 * records sharing one must be shown as a conflict, not refused by the database.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS disposable_machines (
    attach_id TEXT PRIMARY KEY,
    provisioner_json TEXT NOT NULL,
    delegation_json TEXT NOT NULL,
    name TEXT NOT NULL,
    label TEXT,
    expected_sign_pub TEXT NOT NULL,
    expected_noise_pub TEXT NOT NULL,
    node_id TEXT NOT NULL,
    grant_id TEXT NOT NULL,
    mint_id TEXT UNIQUE,
    invite_id TEXT UNIQUE,
    invite_expires_at TEXT,
    offer_nonce TEXT,
    admit_hash TEXT,
    state TEXT NOT NULL,
    step TEXT,
    fence INTEGER NOT NULL DEFAULT 0,
    effects_json TEXT NOT NULL DEFAULT '[]',
    sshd_pin TEXT,
    route_json TEXT,
    link_operation_id TEXT,
    link_id TEXT,
    environment_id TEXT,
    machine_install_id TEXT,
    conflicts_json TEXT NOT NULL DEFAULT '[]',
    pen_admitted_at TEXT,
    pen_removed_at TEXT,
    created_at TEXT NOT NULL,
    state_since TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    final_at TEXT
  )`;
  for (const column of ["node_id", "expected_sign_pub", "expected_noise_pub"] as const)
    yield* sql.unsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS disposable_machines_open_${column} ON disposable_machines(${column}) WHERE final_at IS NULL`,
    );
});
