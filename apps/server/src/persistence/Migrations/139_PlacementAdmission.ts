import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Placement admission (docs/internals/agentic-k8s.md): the target's reservations and prune watermark,
 * and the placer's per-attempt history with its never-pruned attempt counter.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE placement_reservations (
    placer TEXT NOT NULL,
    owner_key TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    issued_at INTEGER NOT NULL,
    command_id TEXT NOT NULL UNIQUE,
    digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending', 'counted', 'fenced')),
    owner_epoch TEXT NOT NULL,
    thread_id TEXT,
    run_id TEXT,
    admitted_at INTEGER NOT NULL,
    lease_until INTEGER NOT NULL,
    reason TEXT,
    PRIMARY KEY (placer, owner_key, attempt, issued_at)
  )`;
  yield* sql`CREATE INDEX placement_reservations_by_placer ON placement_reservations(placer, issued_at)`;
  yield* sql`CREATE INDEX placement_reservations_by_state ON placement_reservations(state, lease_until)`;
  yield* sql`CREATE TABLE placement_watermark (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    issued_at INTEGER NOT NULL
  )`;
  yield* sql`INSERT INTO placement_watermark (id, issued_at) VALUES (1, 0)`;
  yield* sql`CREATE TABLE placement_attempts (
    owner_key TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    issued_at INTEGER NOT NULL,
    target_host TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('unknown', 'started', 'not_started')),
    thread_id TEXT,
    run_id TEXT,
    rerun_by TEXT,
    rerun_at INTEGER,
    cleanup_thread_id TEXT,
    last_answer TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (owner_key, attempt)
  )`;
  yield* sql`CREATE UNIQUE INDEX placement_attempts_one_current ON placement_attempts(owner_key)
    WHERE state = 'unknown' AND rerun_by IS NULL`;
  yield* sql`CREATE TABLE placement_attempt_counters (
    owner_key TEXT PRIMARY KEY,
    next_attempt INTEGER NOT NULL
  )`;
});
