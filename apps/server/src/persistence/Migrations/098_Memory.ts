import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS memory_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    protocol_version INTEGER NOT NULL CHECK(protocol_version=1),
    memory_space_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    origin_environment_id TEXT NOT NULL,
    operation_digest TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK(created_at>=0),
    UNIQUE(memory_space_id,operation_id)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS memory_revisions (
    space TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    parents_json TEXT NOT NULL,
    scope_json TEXT NOT NULL,
    assertion_kind TEXT NOT NULL CHECK(assertion_kind IN ('fact','inference')),
    provenance_json TEXT NOT NULL,
    payload_ref TEXT,
    created_at INTEGER NOT NULL CHECK(created_at>=0),
    PRIMARY KEY(space,revision_id)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS memory_payloads (
    space TEXT NOT NULL,
    payload_ref TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    body_json TEXT NOT NULL,
    dependencies_json TEXT NOT NULL,
    replaced_at INTEGER,
    resolved_at INTEGER,
    purge_eligible_after INTEGER,
    revert_deadline INTEGER,
    PRIMARY KEY(space,payload_ref)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS memory_items (
    rowid INTEGER PRIMARY KEY,
    space TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    scope_json TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    heads_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active','quarantined','forgotten','blocked')),
    payload_ref TEXT,
    projection_watermark INTEGER NOT NULL CHECK(projection_watermark>=0),
    item_json TEXT NOT NULL,
    availability_json TEXT NOT NULL,
    scanner_policy_version INTEGER NOT NULL DEFAULT 0,
    scanner_rules_json TEXT NOT NULL DEFAULT '[]',
    scanned_at INTEGER,
    index_state TEXT NOT NULL DEFAULT 'pending' CHECK(index_state IN ('pending','held','ready')),
    indexed_revision TEXT,
    indexed_generation INTEGER,
    indexed_bytes INTEGER NOT NULL DEFAULT 0 CHECK(indexed_bytes>=0),
    generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
    cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_pending IN (0,1)),
    report_pending INTEGER NOT NULL DEFAULT 0 CHECK(report_pending IN (0,1)),
    deferred_json TEXT NOT NULL DEFAULT '[]',
    UNIQUE(space,memory_id)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS memory_tombstones (
    space TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    delete_operation_id TEXT NOT NULL,
    deleting_environment_id TEXT NOT NULL,
    deleted_at INTEGER NOT NULL,
    suppressed_source_keys_json TEXT NOT NULL,
    suppressed_content_json TEXT NOT NULL,
    source_exclusions_json TEXT NOT NULL,
    fragment_status TEXT CHECK(fragment_status IN ('accepted','rejected')),
    fragment_operation_id TEXT,
    fragment_operation_digest TEXT,
    fragment_digest TEXT,
    fragment_keys INTEGER,
    fragment_bytes INTEGER,
    PRIMARY KEY(space,memory_id)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS memory_conflicts (
    space TEXT NOT NULL,
    conflict_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    heads_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('quarantined','resolving','failed','resolved')),
    failure_code TEXT,
    attempt_id TEXT,
    PRIMARY KEY(space,conflict_id),
    CHECK((status='failed')=(failure_code IS NOT NULL))
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS memory_resolutions (
    space TEXT NOT NULL,
    resolution_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    input_revision_ids_json TEXT NOT NULL,
    input_payload_refs_json TEXT NOT NULL,
    judgment_payload_ref TEXT NOT NULL,
    requested_model_selection_json TEXT NOT NULL,
    effective_provider_model_json TEXT NOT NULL,
    resolving_environment_id TEXT NOT NULL,
    fencing_token INTEGER NOT NULL CHECK(fencing_token>0),
    result_revision_id TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    revert_deadline INTEGER NOT NULL,
    revert_operation_id TEXT,
    resolution_json TEXT NOT NULL,
    PRIMARY KEY(space,resolution_id),
    UNIQUE(space,result_revision_id)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS memory_revert_intents (
    space TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    resolution_id TEXT NOT NULL,
    restored_revision_id TEXT NOT NULL,
    expected_heads_json TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    submission_metadata_json TEXT NOT NULL,
    payload_ref TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(space,operation_id),
    UNIQUE(space,resolution_id)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS memory_outbox (
    id TEXT PRIMARY KEY,
    space TEXT NOT NULL,
    memory_id TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('sync','revert_intent','summary','consolidate','claim','resolve','rebuild','admin')),
    status TEXT NOT NULL CHECK(status IN ('pending','running','retry','completed','cancelled','failed')),
    metadata_json TEXT NOT NULL,
    payload_ref TEXT,
    attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt>=0),
    next_attempt_at INTEGER NOT NULL,
    claimed_by TEXT,
    claimed_until INTEGER,
    completed_receipt_json TEXT
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS memory_inbox_pending (
    space TEXT NOT NULL,
    pending_key TEXT NOT NULL,
    record_kind TEXT NOT NULL CHECK(record_kind IN ('operation','checkpoint')),
    operation_id TEXT,
    memory_id TEXT,
    operation_digest TEXT,
    missing_parents_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    hub_sequence INTEGER,
    checkpoint_id TEXT,
    page_ordinal INTEGER,
    metadata_json TEXT NOT NULL,
    payload_ref TEXT,
    PRIMARY KEY(space,pending_key)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS memory_sync_cursors (
    space TEXT NOT NULL,
    hub_environment_id TEXT NOT NULL,
    after_sequence INTEGER NOT NULL CHECK(after_sequence>=0),
    bootstrap_state TEXT NOT NULL CHECK(bootstrap_state IN ('unbound','staging','ready')),
    checkpoint_id TEXT,
    checkpoint_sequence INTEGER,
    snapshot_token TEXT,
    checkpoint_cursor TEXT,
    last_success_at INTEGER,
    PRIMARY KEY(space,hub_environment_id)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS memory_import_receipts (
    receipt_id TEXT PRIMARY KEY,
    space TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    record_kind TEXT NOT NULL CHECK(record_kind IN ('source','batch','item')),
    source_id TEXT,
    format TEXT,
    source_locator TEXT,
    source_item_key TEXT,
    parser_version TEXT,
    scope_json TEXT,
    accepted_source_fingerprint TEXT,
    accepted_content_fingerprints_json TEXT,
    observed_rejected_fingerprint TEXT,
    memory_id TEXT,
    accepted_revision_id TEXT,
    batch_operation_id TEXT,
    request_digest TEXT,
    completed_items_json TEXT,
    outcome TEXT,
    issue TEXT,
    observed_at_utc TEXT NOT NULL,
    suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
    source_aliases_json TEXT,
    registration_json TEXT,
    CHECK((record_kind='batch')=(batch_operation_id IS NOT NULL)),
    CHECK(record_kind!='source' OR (source_id IS NOT NULL AND source_item_key IS NULL)),
    CHECK(record_kind!='item' OR (source_id IS NOT NULL AND source_item_key IS NOT NULL))
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS memory_report_outbox (
    report_id TEXT PRIMARY KEY,
    space TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    resolution_id TEXT,
    attempt_id TEXT,
    resolving_environment_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('resolved','failed','reverted')),
    state TEXT NOT NULL CHECK(state IN ('pending','delivered','failed')),
    failure_code TEXT,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    claimed_by TEXT,
    claimed_until INTEGER,
    report_thread_json TEXT,
    delivered_sequence INTEGER,
    CHECK((state='delivered')=(delivered_at IS NOT NULL AND report_thread_json IS NOT NULL AND delivered_sequence IS NOT NULL)),
    CHECK(state!='failed' OR failure_code IS NOT NULL)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS memory_project_bindings (
    memory_space_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    project_key_json TEXT,
    repository_key_json TEXT,
    version INTEGER NOT NULL CHECK(version>=0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(memory_space_id,environment_id,project_id)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS memory_quota_counters (
    space TEXT NOT NULL,
    dimension TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    value INTEGER NOT NULL CHECK(value>=0),
    PRIMARY KEY(space,dimension,scope_key)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS memory_identity_ledger (
    space TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    identity_json TEXT NOT NULL,
    fence_json TEXT NOT NULL,
    reserve_bytes INTEGER NOT NULL CHECK(reserve_bytes>=0),
    reserve_keys INTEGER NOT NULL DEFAULT 0 CHECK(reserve_keys>=0),
    PRIMARY KEY(space,memory_id)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS memory_compact_receipts (
    space TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    operation_digest TEXT NOT NULL,
    hub_sequence INTEGER NOT NULL,
    receipt_json TEXT NOT NULL,
    compact_json TEXT NOT NULL,
    compact_blob BLOB,
    report_key TEXT,
    PRIMARY KEY(space,operation_id),
    UNIQUE(space,report_key)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS memory_import_keys (
    space TEXT NOT NULL,
    key_kind TEXT NOT NULL,
    key TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY(space,key_kind,key)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS memory_compaction_state (
    space TEXT PRIMARY KEY,
    projection_watermark INTEGER NOT NULL DEFAULT 0 CHECK(projection_watermark>=0),
    checkpoint_id TEXT,
    boundary_json TEXT,
    retained_revision_boundary INTEGER NOT NULL DEFAULT 0,
    current_sample_json TEXT,
    blocked_reason TEXT,
    published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1))
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS memory_fts_maintenance_state (
    environment TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK(state IN ('open','braked')),
    changed_at INTEGER,
    allocated_bytes INTEGER,
    measured_at INTEGER,
    measurement_status TEXT NOT NULL CHECK(measurement_status IN ('available','unavailable')),
    merge_pending INTEGER NOT NULL DEFAULT 0 CHECK(merge_pending IN (0,1)),
    changed_rows INTEGER NOT NULL DEFAULT 0 CHECK(changed_rows>=0),
    last_merge_at INTEGER,
    CHECK((measurement_status='available')=(allocated_bytes IS NOT NULL))
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS memory_storage_samples (
    environment TEXT NOT NULL,
    utc_day TEXT NOT NULL,
    measured_at INTEGER NOT NULL,
    sample_json TEXT NOT NULL,
    is_current INTEGER NOT NULL CHECK(is_current IN (0,1)),
    PRIMARY KEY(environment,utc_day)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS memory_pending_forget_intents (
    space TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    requested_at_utc TEXT NOT NULL,
    attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 2147483647),
    last_failure_code TEXT,
    operation_digest TEXT,
    submission_state TEXT NOT NULL CHECK(submission_state IN ('unsubmitted','uncertain','rejected')),
    PRIMARY KEY(space,memory_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS memory_events_memory_idx ON memory_events(memory_space_id,memory_id,sequence)`;
  yield* sql`CREATE INDEX IF NOT EXISTS memory_compact_revision_idx ON memory_compact_receipts(space,json_extract(compact_json,'$.revisionId'))`;
  yield* sql`CREATE INDEX IF NOT EXISTS memory_revisions_memory_idx ON memory_revisions(space,memory_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS memory_payloads_memory_idx ON memory_payloads(space,memory_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS memory_items_scope_idx ON memory_items(space,scope_key,status,memory_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS memory_conflicts_memory_idx ON memory_conflicts(space,memory_id,status)`;
  yield* sql`CREATE INDEX IF NOT EXISTS memory_resolutions_memory_idx ON memory_resolutions(space,memory_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS memory_revert_memory_idx ON memory_revert_intents(space,memory_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS memory_outbox_due_idx ON memory_outbox(status,next_attempt_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS memory_inbox_memory_idx ON memory_inbox_pending(space,memory_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS memory_report_due_idx ON memory_report_outbox(state,claimed_until)`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS memory_inbox_operation_idx ON memory_inbox_pending(space,operation_id) WHERE record_kind='operation'`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS memory_inbox_checkpoint_idx ON memory_inbox_pending(space,checkpoint_id,page_ordinal) WHERE record_kind='checkpoint'`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS memory_import_source_idx ON memory_import_receipts(space,environment_id,source_id) WHERE record_kind='source'`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS memory_import_batch_idx ON memory_import_receipts(space,environment_id,batch_operation_id) WHERE record_kind='batch'`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS memory_import_item_idx ON memory_import_receipts(space,environment_id,source_id,source_item_key) WHERE record_kind='item'`;
  // Search availability is separate from canonical storage readiness.
  yield* sql`CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts USING fts5(body, tokenize='unicode61')`.pipe(
    Effect.catch((error) =>
      /no such module: fts5/i.test(String(error.cause)) ? Effect.void : Effect.fail(error),
    ),
  );
});
