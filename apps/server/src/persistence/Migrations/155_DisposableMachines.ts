import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * One row per attach. Keys are unique while final_at is null; mint and invite ids in every row (Pen
 * reuses neither). The CHECK makes a final state set final_at, so "open" is final_at IS NULL. Pin,
 * environment, install and link ids are left to the class rules: two records sharing one are a
 * conflict to show, not a write to refuse.
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
    final_at TEXT,
    CHECK (final_at IS NOT NULL OR state NOT IN ('failed', 'purged', 'destroyed', 'kept'))
  )`;
  for (const column of ["node_id", "expected_sign_pub", "expected_noise_pub"] as const)
    yield* sql.unsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS disposable_machines_open_${column} ON disposable_machines(${column}) WHERE final_at IS NULL`,
    );
  // Serves the open-record read each hub node snapshot makes.
  yield* sql`CREATE INDEX IF NOT EXISTS disposable_machines_open_order
    ON disposable_machines(created_at, attach_id) WHERE final_at IS NULL`;
});
