import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * GOAT Bot sessions: a row per session generation, and a row per message sent into one, written
 * before the send so a run maps to its task the moment it exists.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE channel_bot_sessions (
    conversation_id TEXT NOT NULL REFERENCES channel_conversations(conversation_id),
    generation INTEGER NOT NULL,
    binding_key TEXT NOT NULL,
    thread_id TEXT NOT NULL UNIQUE,
    task_id TEXT,
    task_generation INTEGER,
    state TEXT NOT NULL,
    driver_kind TEXT,
    sharing TEXT NOT NULL,
    model_instance_id TEXT NOT NULL,
    model TEXT NOT NULL,
    requester_json TEXT NOT NULL,
    context_revision TEXT,
    context_text TEXT,
    last_request_at TEXT,
    created_at TEXT NOT NULL,
    retired_at TEXT,
    version INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (conversation_id, generation)
  )`;
  yield* sql`CREATE UNIQUE INDEX channel_bot_sessions_current_idx ON channel_bot_sessions(binding_key)
    WHERE state != 'retired'`;
  yield* sql`CREATE TABLE channel_bot_session_runs (
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    task_generation INTEGER NOT NULL,
    kind TEXT NOT NULL,
    run_id TEXT,
    steered_into_run_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, message_id)
  )`;
  yield* sql`CREATE UNIQUE INDEX channel_bot_session_runs_run_idx
    ON channel_bot_session_runs(thread_id, run_id) WHERE run_id IS NOT NULL`;
  yield* sql`CREATE INDEX channel_bot_session_runs_task_idx
    ON channel_bot_session_runs(task_id, task_generation)`;
});
