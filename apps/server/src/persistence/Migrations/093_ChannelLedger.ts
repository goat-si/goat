import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The channel ledger: conversations from GOAT bot, Slack, and MCP input, the work requested in
 * them, the append-only task events, and the inbox and outbox that make intake and delivery
 * survive restarts. JSON columns hold contract payloads; plain columns hold what is queried.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TABLE IF NOT EXISTS channel_conversations (
    conversation_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    conversation_key TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    last_activity_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    UNIQUE (owner_id, kind, connection_id, conversation_key)
  )`;

  yield* sql`CREATE TABLE IF NOT EXISTS channel_bindings (
    binding_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES channel_conversations(conversation_id),
    connection_id TEXT NOT NULL,
    reply_address_json TEXT NOT NULL,
    last_activity_at TEXT NOT NULL
  )`;

  yield* sql`CREATE TABLE IF NOT EXISTS channel_inbox (
    input_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES channel_conversations(conversation_id),
    binding_id TEXT NOT NULL REFERENCES channel_bindings(binding_id),
    message_json TEXT NOT NULL,
    requester_json TEXT,
    state TEXT NOT NULL,
    accepted_at TEXT NOT NULL,
    read_at TEXT,
    reception_id TEXT,
    decision_json TEXT,
    reply_json TEXT,
    failure_json TEXT,
    task_ids_json TEXT NOT NULL DEFAULT '[]',
    timeline_sequence INTEGER,
    UNIQUE (owner_id, kind, connection_id, idempotency_key)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS channel_inbox_conversation_idx
    ON channel_inbox(conversation_id, accepted_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS channel_inbox_pending_idx
    ON channel_inbox(state) WHERE state IN ('accepted', 'processing')`;

  yield* sql`CREATE TABLE IF NOT EXISTS channel_tasks (
    task_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES channel_conversations(conversation_id),
    status TEXT NOT NULL,
    version INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    worker_thread_id TEXT,
    pending_answer_message_id TEXT,
    completion_hold TEXT,
    task_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS channel_tasks_owner_idx ON channel_tasks(owner_id, updated_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS channel_tasks_worker_idx ON channel_tasks(worker_thread_id)
    WHERE worker_thread_id IS NOT NULL`;
  yield* sql`CREATE INDEX IF NOT EXISTS channel_tasks_active_idx ON channel_tasks(status)
    WHERE status NOT IN ('completed', 'failed', 'cancelled')`;

  yield* sql`CREATE TABLE IF NOT EXISTS channel_task_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    task_id TEXT NOT NULL REFERENCES channel_tasks(task_id),
    task_version INTEGER NOT NULL,
    type TEXT NOT NULL,
    event_json TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    narration_state TEXT NOT NULL DEFAULT 'none',
    forward_state TEXT NOT NULL DEFAULT 'none',
    UNIQUE (task_id, task_version)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS channel_task_events_narration_idx
    ON channel_task_events(narration_state) WHERE narration_state = 'pending'`;
  yield* sql`CREATE INDEX IF NOT EXISTS channel_task_events_forward_idx
    ON channel_task_events(forward_state) WHERE forward_state = 'pending'`;

  yield* sql`CREATE TABLE IF NOT EXISTS channel_outbox (
    delivery_id TEXT PRIMARY KEY,
    cause_key TEXT NOT NULL UNIQUE,
    input_id TEXT,
    task_id TEXT,
    kind TEXT NOT NULL,
    destination_kind TEXT NOT NULL,
    message_json TEXT NOT NULL,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    external_message_id TEXT,
    last_error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  // Oldest open rows first for the delivery claim, and each task's earlier open rows for its
  // ordering check, so claiming stays cheap however long the delivered history grows.
  yield* sql`CREATE INDEX IF NOT EXISTS channel_outbox_due_idx ON channel_outbox(state, created_at)
    WHERE state IN ('pending', 'delivering')`;
  yield* sql`CREATE INDEX IF NOT EXISTS channel_outbox_task_order_idx
    ON channel_outbox(task_id, destination_kind) WHERE state IN ('pending', 'delivering')`;

  yield* sql`CREATE TABLE IF NOT EXISTS channel_runtime_state (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    owner_token TEXT,
    heartbeat_at TEXT,
    updated_at TEXT NOT NULL
  )`;

  yield* sql`CREATE TABLE IF NOT EXISTS channel_identities (
    connection_id TEXT NOT NULL,
    external_actor_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    runtime_mode_ceiling TEXT NOT NULL,
    granted_scopes_json TEXT NOT NULL,
    linked_at TEXT NOT NULL,
    PRIMARY KEY (connection_id, external_actor_id)
  )`;

  yield* sql`CREATE TABLE IF NOT EXISTS channel_identity_links (
    code_hash TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    runtime_mode_ceiling TEXT NOT NULL,
    granted_scopes_json TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    created_at TEXT NOT NULL
  )`;
});
