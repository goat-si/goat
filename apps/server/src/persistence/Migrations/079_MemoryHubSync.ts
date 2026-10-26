import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE memory_hub_members (
    space TEXT NOT NULL, environment TEXT NOT NULL, credential_digest TEXT NOT NULL UNIQUE,
    credential_version INTEGER NOT NULL CHECK(credential_version>0),
    status TEXT NOT NULL CHECK(status IN ('active','revoked')), joined_at INTEGER,
    PRIMARY KEY(space,environment)
  )`;
  yield* sql`CREATE TABLE memory_hub_operations (
    hub_sequence INTEGER PRIMARY KEY AUTOINCREMENT, space TEXT NOT NULL, operation_id TEXT NOT NULL,
    memory_id TEXT NOT NULL, origin_environment TEXT NOT NULL, operation_digest TEXT NOT NULL,
    entry_json TEXT NOT NULL, payload_ref TEXT, committed_at INTEGER NOT NULL,
    UNIQUE(space,operation_id)
  )`;
  yield* sql`CREATE INDEX memory_hub_operations_space_sequence ON memory_hub_operations(space,hub_sequence)`;
  yield* sql`CREATE TABLE memory_hub_leases (
    space TEXT NOT NULL, memory_id TEXT NOT NULL, highest_token INTEGER NOT NULL CHECK(highest_token>=0),
    lease_json TEXT, PRIMARY KEY(space,memory_id)
  )`;
  yield* sql`CREATE TABLE memory_hub_source_reads (
    space TEXT NOT NULL, request_id TEXT NOT NULL, memory_id TEXT NOT NULL,
    requester TEXT NOT NULL, owner TEXT NOT NULL, credential_version INTEGER NOT NULL,
    request_digest TEXT NOT NULL, locator_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','completed','expired')),
    deadline INTEGER NOT NULL, response_digest TEXT, payload_ref TEXT,
    PRIMARY KEY(space,request_id)
  )`;
  yield* sql`CREATE INDEX memory_hub_source_reads_owner ON memory_hub_source_reads(space,owner,state,deadline)`;
  yield* sql`CREATE INDEX memory_hub_source_reads_memory ON memory_hub_source_reads(space,memory_id)`;
  yield* sql`CREATE TABLE memory_hub_retention (
    space TEXT PRIMARY KEY, checkpoint_id TEXT, checkpoint_sequence INTEGER NOT NULL DEFAULT 0,
    retention_floor INTEGER NOT NULL DEFAULT 0, boundary_json TEXT, handles_json TEXT NOT NULL DEFAULT '[]',
    compaction_json TEXT, reserved_snapshot_id TEXT, snapshot_generation INTEGER, last_snapshot_bytes INTEGER NOT NULL DEFAULT 0 CHECK(last_snapshot_bytes>=0), checkpoint_bytes INTEGER NOT NULL DEFAULT 0 CHECK(checkpoint_bytes>=0),
    published_pinned_bytes INTEGER NOT NULL DEFAULT 0 CHECK(published_pinned_bytes>=0),
    CHECK(retention_floor>=0 AND retention_floor<=checkpoint_sequence)
  )`;
  yield* sql`ALTER TABLE memory_outbox ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 0 CHECK(sync_version>=0)`;
  yield* sql`ALTER TABLE memory_outbox ADD COLUMN operation_digest TEXT`;
  yield* sql`ALTER TABLE memory_outbox ADD COLUMN frozen_claim_json TEXT`;
  yield* sql`ALTER TABLE memory_outbox ADD COLUMN ticket_json TEXT`;
  yield* sql`ALTER TABLE memory_outbox ADD COLUMN admin_json TEXT`;
  yield* sql`UPDATE memory_outbox SET operation_digest=(
    (SELECT e.operation_digest FROM memory_events e WHERE e.memory_space_id=memory_outbox.space AND e.operation_id=json_extract(memory_outbox.metadata_json,'$.operationId'))
  ) WHERE kind IN ('sync','revert_intent')`;
  yield* sql`CREATE INDEX memory_outbox_sync_due ON memory_outbox(space,kind,status,next_attempt_at,claimed_until)`;
  // Only active resolve rows participate; completed history cannot enlarge the claim barrier.
  yield* sql`CREATE INDEX memory_outbox_active_resolution ON memory_outbox(space,memory_id) WHERE kind='resolve' AND status IN ('pending','retry','running')`;
  yield* sql`ALTER TABLE memory_outbox ADD COLUMN terminal_at INTEGER`;
  yield* sql`ALTER TABLE memory_outbox ADD COLUMN hold_class TEXT CHECK(hold_class IN ('authorization','protocol','identity','availability'))`;
  // Four presence probes must also be bounded when a class is absent. The due
  // index cannot bound filtering by hold_class among many MAX retry rows.
  yield* sql`CREATE INDEX memory_outbox_held_class ON memory_outbox(space,hold_class)
    WHERE hold_class IS NOT NULL AND next_attempt_at=9007199254740991
      AND kind IN ('sync','revert_intent','claim','resolve')
      AND status IN ('pending','retry','running')`;
  yield* sql`ALTER TABLE memory_outbox ADD COLUMN failure_code TEXT CHECK(length(failure_code)<=64)`;

  yield* sql`ALTER TABLE memory_sync_cursors ADD COLUMN pull_retry_json TEXT CHECK(length(CAST(pull_retry_json AS BLOB))<=512)`;
  yield* sql`ALTER TABLE memory_sync_cursors ADD COLUMN checkpoint_page_count INTEGER NOT NULL DEFAULT 0 CHECK(checkpoint_page_count>=0)`;
  yield* sql`ALTER TABLE memory_payloads ADD COLUMN checkpoint_stage_id TEXT`;
  yield* sql`UPDATE memory_sync_cursors SET checkpoint_page_count=(SELECT count(*) FROM memory_inbox_pending p WHERE p.space=memory_sync_cursors.space AND p.checkpoint_id=memory_sync_cursors.checkpoint_id AND p.record_kind='checkpoint')`;
  yield* sql`CREATE TRIGGER memory_bootstrap_page_insert AFTER INSERT ON memory_inbox_pending WHEN NEW.record_kind='checkpoint' BEGIN
    UPDATE memory_sync_cursors SET checkpoint_page_count=checkpoint_page_count+1 WHERE space=NEW.space AND checkpoint_id=NEW.checkpoint_id AND bootstrap_state='staging';
  END`;
  yield* sql`CREATE TRIGGER memory_bootstrap_page_delete AFTER DELETE ON memory_inbox_pending WHEN OLD.record_kind='checkpoint' BEGIN
    UPDATE memory_sync_cursors SET checkpoint_page_count=checkpoint_page_count-1 WHERE space=OLD.space AND checkpoint_id=OLD.checkpoint_id AND bootstrap_state='staging';
  END`;
  const counterSpace = "_hub_global";
  // Seed once from the upgrade snapshot. Every later row delta is maintained by SQLite in its writer transaction.
  const receiptBytes = 336;
  const privateInventory = [
    [
      "memory_hub_members",
      "length(CAST(space AS BLOB))+length(CAST(environment AS BLOB))+length(CAST(credential_digest AS BLOB))+length(CAST(credential_version AS TEXT))+length(CAST(status AS BLOB))+coalesce(length(CAST(joined_at AS TEXT)),0)",
    ],
    [
      "memory_hub_leases",
      "length(CAST(space AS BLOB))+length(CAST(memory_id AS BLOB))+length(CAST(highest_token AS TEXT))+coalesce(length(CAST(lease_json AS BLOB)),0)",
    ],
    [
      "memory_hub_source_reads",
      "length(CAST(locator_json AS BLOB))+length(CAST(request_digest AS BLOB))+coalesce(length(CAST(response_digest AS BLOB)),0)",
    ],
    [
      "memory_hub_retention",
      "coalesce(length(CAST(boundary_json AS BLOB)),0)+length(CAST(handles_json AS BLOB))+coalesce(length(CAST(compaction_json AS BLOB)),0)",
    ],
    [
      "memory_outbox",
      "coalesce(length(CAST(admin_json AS BLOB)),0)+coalesce(length(CAST(ticket_json AS BLOB)),0)+coalesce(length(CAST(frozen_claim_json AS BLOB)),0)+coalesce(length(CAST(hold_class AS BLOB)),0)+coalesce(length(CAST(failure_code AS BLOB)),0)",
    ],
    [
      "memory_report_outbox",
      "length(CAST(report_id AS BLOB))+length(CAST(operation_id AS BLOB))+length(CAST(resolving_environment_id AS BLOB))+coalesce(length(CAST(resolution_id AS BLOB)),0)+coalesce(length(CAST(report_thread_json AS BLOB)),0)+32",
    ],
  ] as const;
  const privateTotal = privateInventory
    .map(([table, expression]) => `(SELECT coalesce(sum(${expression}),0) FROM ${table})`)
    .join("+");
  const canonicalTotal = `(SELECT coalesce(sum(reserve_bytes),0) FROM memory_identity_ledger)+(SELECT coalesce(sum(length(CAST(record_json AS BLOB))),0) FROM memory_import_keys)+(SELECT coalesce(sum(coalesce(length(compact_blob),length(CAST(compact_json AS BLOB)))),0) FROM memory_compact_receipts)+(SELECT count(*)*${receiptBytes} FROM memory_events e WHERE NOT EXISTS(SELECT 1 FROM memory_compact_receipts c WHERE c.space=e.memory_space_id AND c.operation_id=e.operation_id))+(SELECT count(*)*${receiptBytes} FROM memory_identity_ledger i WHERE NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.space=i.space AND t.memory_id=i.memory_id))`;
  const guardKinds =
    "('hub_attempt','hub_checkpoint_token','ticket_terminal','hub_admin','report_delivered')";
  const counts = [
    ["hub_metadata", `${canonicalTotal}+${privateTotal}`],
    ["hub_private_metadata", privateTotal],
    [
      "hub_receipts",
      `(SELECT count(*) FROM (SELECT memory_space_id AS space,operation_id FROM memory_events UNION SELECT space,operation_id FROM memory_compact_receipts))+(SELECT count(*) FROM memory_identity_ledger i WHERE NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.space=i.space AND t.memory_id=i.memory_id))+(SELECT count(*) FROM memory_import_keys WHERE key_kind IN ${guardKinds})+(SELECT count(*) FROM memory_outbox WHERE kind='admin')`,
    ],
    [
      "hub_checkpoint",
      "(SELECT coalesce(sum(checkpoint_bytes+published_pinned_bytes),0) FROM memory_hub_retention)",
    ],
    ["hub_ids", "(SELECT count(*) FROM memory_identity_ledger)"],
    [
      "hub_keys",
      "(SELECT count(*) FROM memory_import_keys)+(SELECT coalesce(sum(reserve_keys),0) FROM memory_identity_ledger)+(SELECT count(*) FROM memory_outbox WHERE kind='admin')",
    ],
  ] as const;
  for (const [dimension, expression] of counts)
    yield* sql.unsafe(
      `INSERT INTO memory_quota_counters(space,dimension,scope_key,value) SELECT ?,?,'',${expression}`,
      [counterSpace, dimension],
    );
  const delta = (dimension: string, expression: string) =>
    `UPDATE memory_quota_counters SET value=value+(${expression}) WHERE space='${counterSpace}' AND dimension='${dimension}' AND scope_key='';`;
  const install = Effect.fn("MemoryHubSync.installQuotaTriggers")(function* (
    table: string,
    insert: string,
    update: string,
    remove: string,
  ) {
    for (const [action, body] of [
      ["INSERT", insert],
      ["UPDATE", update],
      ["DELETE", remove],
    ] as const)
      yield* sql.unsafe(
        `CREATE TRIGGER ${table}_hub_account_${action.toLowerCase()} AFTER ${action} ON ${table} BEGIN ${body} END`,
      );
  });
  for (const [table, expression] of privateInventory) {
    const qualify = (prefix: string) =>
      expression.replace(
        /\b(space|environment|credential_digest|credential_version|status|joined_at|memory_id|highest_token|lease_json|locator_json|request_digest|response_digest|boundary_json|handles_json|compaction_json|admin_json|ticket_json|frozen_claim_json|hold_class|failure_code|report_id|operation_id|resolving_environment_id|resolution_id|report_thread_json)\b/g,
        `${prefix}.$1`,
      );
    const charge = (value: string) =>
      delta("hub_metadata", value) + delta("hub_private_metadata", value);
    const checkpoint = (expression: string) =>
      table === "memory_hub_retention" ? delta("hub_checkpoint", expression) : "";
    const adminOnly = (prefix: string) =>
      `CASE WHEN ${prefix}.kind='admin' AND NOT EXISTS(SELECT 1 FROM memory_import_keys g WHERE g.space='_admin' AND g.key_kind='hub_admin' AND g.key=substr(${prefix}.id,7)) THEN 1 ELSE 0 END`;
    const adminReservation = (expression: string) =>
      table === "memory_outbox"
        ? delta("hub_receipts", expression) + delta("hub_keys", expression)
        : "";
    yield* install(
      table,
      charge(qualify("NEW")) +
        checkpoint("NEW.checkpoint_bytes+NEW.published_pinned_bytes") +
        adminReservation(adminOnly("NEW")),
      charge(`${qualify("NEW")}-(${qualify("OLD")})`) +
        checkpoint(
          "NEW.checkpoint_bytes+NEW.published_pinned_bytes-OLD.checkpoint_bytes-OLD.published_pinned_bytes",
        ) +
        adminReservation(`${adminOnly("NEW")}-${adminOnly("OLD")}`),
      charge(`-(${qualify("OLD")})`) +
        checkpoint("-OLD.checkpoint_bytes-OLD.published_pinned_bytes") +
        adminReservation(`-(${adminOnly("OLD")})`),
    );
  }
  const identityCharge = (prefix: string) =>
    `${prefix}.reserve_bytes+CASE WHEN NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.space=${prefix}.space AND t.memory_id=${prefix}.memory_id) THEN ${receiptBytes} ELSE 0 END`;
  const identityCount = (prefix: string) =>
    `CASE WHEN NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.space=${prefix}.space AND t.memory_id=${prefix}.memory_id) THEN 1 ELSE 0 END`;
  yield* install(
    "memory_identity_ledger",
    delta("hub_metadata", identityCharge("NEW")) +
      delta("hub_receipts", identityCount("NEW")) +
      delta("hub_ids", "1") +
      delta("hub_keys", "NEW.reserve_keys"),
    delta("hub_metadata", "NEW.reserve_bytes-OLD.reserve_bytes") +
      delta("hub_keys", "NEW.reserve_keys-OLD.reserve_keys"),
    delta("hub_metadata", `-(${identityCharge("OLD")})`) +
      delta("hub_receipts", `-(${identityCount("OLD")})`) +
      delta("hub_ids", "-1") +
      delta("hub_keys", "-OLD.reserve_keys"),
  );
  const tombstoneCharge = (prefix: string) =>
    `CASE WHEN EXISTS(SELECT 1 FROM memory_identity_ledger i WHERE i.space=${prefix}.space AND i.memory_id=${prefix}.memory_id) THEN 1 ELSE 0 END`;
  yield* install(
    "memory_tombstones",
    delta("hub_metadata", `-${receiptBytes}*(${tombstoneCharge("NEW")})`) +
      delta("hub_receipts", `-(${tombstoneCharge("NEW")})`),
    delta("hub_metadata", "0"),
    delta("hub_metadata", `${receiptBytes}*(${tombstoneCharge("OLD")})`) +
      delta("hub_receipts", tombstoneCharge("OLD")),
  );
  const eventOnly = (prefix: string) =>
    `CASE WHEN NOT EXISTS(SELECT 1 FROM memory_compact_receipts c WHERE c.space=${prefix}.memory_space_id AND c.operation_id=${prefix}.operation_id) THEN 1 ELSE 0 END`;
  yield* install(
    "memory_events",
    delta("hub_metadata", `${receiptBytes}*(${eventOnly("NEW")})`) +
      delta("hub_receipts", eventOnly("NEW")),
    delta("hub_metadata", "0"),
    delta("hub_metadata", `-${receiptBytes}*(${eventOnly("OLD")})`) +
      delta("hub_receipts", `-(${eventOnly("OLD")})`),
  );
  const compactBytes = (prefix: string) =>
    `coalesce(length(${prefix}.compact_blob),length(CAST(${prefix}.compact_json AS BLOB)))`;
  const compactOnly = (prefix: string) =>
    `CASE WHEN NOT EXISTS(SELECT 1 FROM memory_events e WHERE e.memory_space_id=${prefix}.space AND e.operation_id=${prefix}.operation_id) THEN 1 ELSE 0 END`;
  yield* install(
    "memory_compact_receipts",
    delta("hub_metadata", `${compactBytes("NEW")}-${receiptBytes}*(1-(${compactOnly("NEW")}))`) +
      delta("hub_receipts", compactOnly("NEW")),
    delta("hub_metadata", `${compactBytes("NEW")}-${compactBytes("OLD")}`),
    delta("hub_metadata", `-${compactBytes("OLD")}+${receiptBytes}*(1-(${compactOnly("OLD")}))`) +
      delta("hub_receipts", `-(${compactOnly("OLD")})`),
  );
  const guardCount = (prefix: string) =>
    `CASE WHEN ${prefix}.key_kind IN ${guardKinds} THEN CASE WHEN ${prefix}.key_kind='hub_admin' AND EXISTS(SELECT 1 FROM memory_outbox o WHERE o.kind='admin' AND o.id='admin:'||${prefix}.key) THEN 0 ELSE 1 END ELSE 0 END`;
  const keyCount = (prefix: string) =>
    `CASE WHEN ${prefix}.key_kind='hub_admin' AND EXISTS(SELECT 1 FROM memory_outbox o WHERE o.kind='admin' AND o.id='admin:'||${prefix}.key) THEN 0 ELSE 1 END`;
  yield* install(
    "memory_import_keys",
    delta("hub_metadata", "length(CAST(NEW.record_json AS BLOB))") +
      delta("hub_receipts", guardCount("NEW")) +
      delta("hub_keys", keyCount("NEW")),
    delta(
      "hub_metadata",
      "length(CAST(NEW.record_json AS BLOB))-length(CAST(OLD.record_json AS BLOB))",
    ) +
      delta("hub_receipts", `${guardCount("NEW")}-${guardCount("OLD")}`) +
      delta("hub_keys", `${keyCount("NEW")}-${keyCount("OLD")}`),
    delta("hub_metadata", "-length(CAST(OLD.record_json AS BLOB))") +
      delta("hub_receipts", `-(${guardCount("OLD")})`) +
      delta("hub_keys", `-(${keyCount("OLD")})`),
  );
  // Deliberately retain historical and private inputs too: expiry/compaction can only reduce this upper bound.
  const snapshotByteBounds = [
    ["memory_items", "space", "item_json,heads_json"],
    [
      "memory_revisions",
      "space",
      "space,revision_id,memory_id,operation_id,parents_json,scope_json,assertion_kind,provenance_json,payload_ref",
    ],
    ["memory_payloads", "space", "body_json"],
    [
      "memory_tombstones",
      "space",
      "space,memory_id,delete_operation_id,deleting_environment_id,suppressed_source_keys_json,suppressed_content_json,source_exclusions_json",
    ],
    [
      "memory_conflicts",
      "space",
      "space,conflict_id,memory_id,heads_json,status,failure_code,attempt_id",
    ],
    ["memory_resolutions", "space", "resolution_json"],
    ["memory_identity_ledger", "space", "identity_json,fence_json"],
    ["memory_compact_receipts", "space", "compact_json,receipt_json"],
    ["memory_import_keys", "space", "record_json"],
    ["memory_events", "memory_space_id", "metadata_json,receipt_json"],
    [
      "memory_outbox",
      "space",
      "metadata_json,admin_json,ticket_json,frozen_claim_json,hold_class,failure_code",
    ],
    ["memory_hub_members", "space", "space,environment,credential_digest,status"],
    ["memory_hub_leases", "space", "lease_json"],
    ["memory_hub_source_reads", "space", "locator_json,request_digest,response_digest"],
    ["memory_sync_cursors", "space", "pull_retry_json"],
  ] as const;
  for (const [table, spaceColumn, columns] of snapshotByteBounds) {
    const rawBytes = (prefix: string) =>
      columns
        .split(",")
        .map((column) => `coalesce(length(CAST(${prefix}${column} AS BLOB)),0)`)
        .join("+") + (table === "memory_identity_ledger" ? `+${prefix}reserve_bytes` : "");
    const bytes = (prefix: string) =>
      table === "memory_import_keys"
        ? `CASE WHEN ${prefix}key_kind='hub_checkpoint_token' THEN 0 ELSE ${rawBytes(prefix)} END`
        : rawBytes(prefix);
    // The identity owns the future basic-forget rows and its source-key suppression records.
    const recordRows = (prefix: string) =>
      table === "memory_identity_ledger"
        ? `1+${prefix}reserve_keys+CASE WHEN NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.space=${prefix}space AND t.memory_id=${prefix}memory_id) THEN 8 ELSE 0 END`
        : table === "memory_import_keys"
          ? `CASE WHEN ${prefix}key_kind='hub_checkpoint_token' THEN 0 ELSE 1 END`
          : "1";
    // Retry extends an existing cursor row; it adds bounded bytes, not canonical snapshot records.
    const dimensions =
      table === "memory_sync_cursors"
        ? ([["hub_snapshot_bytes", bytes("")]] as const)
        : ([
            ["hub_snapshot_bytes", bytes("")],
            ["hub_snapshot_rows", recordRows("")],
          ] as const);
    for (const [dimension, expression] of dimensions) {
      yield* sql.unsafe(
        `INSERT INTO memory_quota_counters(space,dimension,scope_key,value)
        SELECT ${spaceColumn},?,'',sum(${expression}) FROM ${table} GROUP BY ${spaceColumn}
        ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=value+excluded.value`,
        [dimension],
      );
      const change = (prefix: string, sign: number) =>
        sign < 0
          ? `UPDATE memory_quota_counters SET value=value-(${dimension === "hub_snapshot_rows" ? recordRows(`${prefix}.`) : bytes(`${prefix}.`)}) WHERE space=${prefix}.${spaceColumn} AND dimension='${dimension}' AND scope_key='';`
          : `INSERT INTO memory_quota_counters(space,dimension,scope_key,value)
        VALUES (${prefix}.${spaceColumn},'${dimension}','',${dimension === "hub_snapshot_rows" ? recordRows(`${prefix}.`) : bytes(`${prefix}.`)})
        ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=value+excluded.value;`;
      for (const [action, body] of [
        ["INSERT", change("NEW", 1)],
        ["UPDATE", change("OLD", -1) + change("NEW", 1)],
        ["DELETE", change("OLD", -1)],
      ] as const)
        yield* sql.unsafe(
          `CREATE TRIGGER ${table}_${dimension}_${action.toLowerCase()} AFTER ${action} ON ${table} ${action === "UPDATE" ? `WHEN OLD.${spaceColumn} IS NOT NEW.${spaceColumn} OR (${dimension === "hub_snapshot_rows" ? recordRows("OLD.") : bytes("OLD.")}) IS NOT (${dimension === "hub_snapshot_rows" ? recordRows("NEW.") : bytes("NEW.")})` : ""} BEGIN ${body} END`,
        );
    }
  }
  // buildHubSnapshot/loadAggregate also read selectors and scalar fields that are not
  // byte-bound payloads. Keep those dependencies separate from the reservation formula.
  const snapshotSelectors: Readonly<Record<string, string>> = {
    memory_items: "memory_id,payload_ref",
    memory_revisions: "created_at",
    memory_payloads: "payload_ref,memory_id",
    memory_tombstones: "deleted_at",
    memory_conflicts: "memory_id",
    memory_resolutions: "memory_id",
    memory_identity_ledger: "memory_id",
    memory_compact_receipts: "operation_id,hub_sequence",
    memory_import_keys: "key_kind,key,memory_id",
    memory_outbox: "kind,status,memory_id",
  };
  const snapshotDependencies = [
    // Retry is private scheduling state: charge its bytes without invalidating canonical
    // producer staging. buildHubSnapshot does not consume cursor retry state.
    ...snapshotByteBounds
      .filter(([table]) => table !== "memory_sync_cursors")
      .map(
        ([table, spaceColumn, columns]) =>
          [
            table,
            spaceColumn,
            [columns, snapshotSelectors[table]].filter(Boolean).join(","),
          ] as const,
      ),
    ["memory_hub_operations", "space", "hub_sequence"] as const,
  ];
  for (const [table, spaceColumn, columns] of snapshotDependencies) {
    const inputChanged = [
      ...new Set([
        spaceColumn,
        ...columns.split(","),
        ...(table === "memory_import_keys" ? ["key_kind"] : []),
      ]),
    ]
      .map((column) => `OLD.${column} IS NOT NEW.${column}`)
      .join(" OR ");
    for (const action of ["INSERT", "UPDATE", "DELETE"] as const) {
      const prefix = action === "DELETE" ? "OLD" : "NEW";
      const conditions = [
        ...(table === "memory_import_keys"
          ? [
              action === "UPDATE"
                ? "(OLD.key_kind!='hub_checkpoint_token' OR NEW.key_kind!='hub_checkpoint_token')"
                : `${prefix}.key_kind!='hub_checkpoint_token'`,
            ]
          : []),
        ...(action === "UPDATE" ? [`(${inputChanged})`] : []),
      ];
      // Credit is reversible only while a producer staging has neither publication nor a handle.
      // Reclaim it in the input writer's transaction, including admission-free first forget.
      const spaces =
        action === "UPDATE"
          ? [`OLD.${spaceColumn}`, `NEW.${spaceColumn}`]
          : [`${prefix}.${spaceColumn}`];
      const reclaim = spaces
        .map(
          (space) => `
        UPDATE memory_hub_retention SET published_pinned_bytes=published_pinned_bytes-
          (SELECT coalesce(sum(length(CAST(p.metadata_json AS BLOB))),0) FROM memory_inbox_pending p WHERE p.space=memory_hub_retention.space AND p.reason='hub_snapshot' AND p.checkpoint_id='hub:'||reserved_snapshot_id)
          WHERE space=${space} AND reserved_snapshot_id IS NOT NULL AND checkpoint_id IS NOT reserved_snapshot_id
          AND NOT EXISTS(SELECT 1 FROM json_each(handles_json) h WHERE json_extract(h.value,'$.checkpointId')=reserved_snapshot_id);
        DELETE FROM memory_inbox_pending WHERE space=${space} AND reason='hub_snapshot' AND checkpoint_id IN
          (SELECT 'hub:'||reserved_snapshot_id FROM memory_hub_retention WHERE space=${space} AND reserved_snapshot_id IS NOT NULL AND checkpoint_id IS NOT reserved_snapshot_id
          AND NOT EXISTS(SELECT 1 FROM json_each(handles_json) h WHERE json_extract(h.value,'$.checkpointId')=reserved_snapshot_id));
        UPDATE memory_hub_retention SET reserved_snapshot_id=NULL,snapshot_generation=-1 WHERE space=${space} AND reserved_snapshot_id IS NOT NULL AND checkpoint_id IS NOT reserved_snapshot_id
          AND NOT EXISTS(SELECT 1 FROM json_each(handles_json) h WHERE json_extract(h.value,'$.checkpointId')=reserved_snapshot_id);
      `,
        )
        .join("");
      yield* sql.unsafe(`CREATE TRIGGER ${table}_snapshot_generation_${action.toLowerCase()} AFTER ${action} ON ${table} ${conditions.length ? `WHEN ${conditions.join(" AND ")}` : ""} BEGIN
        ${reclaim}
        INSERT INTO memory_quota_counters(space,dimension,scope_key,value) VALUES (${prefix}.${spaceColumn},'hub_snapshot_generation','',1)
        ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=value+1;
      END`);
    }
  }
  for (const [action, prefix, sign] of [
    ["INSERT", "NEW", -1],
    ["DELETE", "OLD", 1],
  ] as const)
    yield* sql.unsafe(`CREATE TRIGGER memory_tombstones_snapshot_forget_${action.toLowerCase()} AFTER ${action} ON memory_tombstones BEGIN
      UPDATE memory_quota_counters SET value=value+${sign}*8 WHERE space=${prefix}.space AND dimension='hub_snapshot_rows' AND scope_key='' AND EXISTS(SELECT 1 FROM memory_identity_ledger i WHERE i.space=${prefix}.space AND i.memory_id=${prefix}.memory_id);
    END`);
  // Fixed counters per space; no text index, history ring or per-operation status rows.
  const processingInventory = [
    {
      table: "memory_items",
      columns:
        "space,status,index_state,indexed_generation,generation,cleanup_pending,deferred_json,availability_json",
      values: (p: string) => [
        ["quarantined", `${p}.status='quarantined'`],
        ["eligible", `${p}.status='active'`],
        [
          "indexed",
          `${p}.status='active' AND ${p}.index_state='ready' AND ${p}.indexed_generation=${p}.generation`,
        ],
        ["cleanup", `${p}.cleanup_pending=1`],
        [
          "scanner_held",
          `EXISTS(SELECT 1 FROM json_each(${p}.availability_json,'$.reasons') WHERE value='secret_detected')`,
        ],
        [
          "scanner_pending",
          `EXISTS(SELECT 1 FROM json_each(${p}.availability_json,'$.reasons') WHERE value='scanner_pending')`,
        ],
        [
          "missing_parent",
          `EXISTS(SELECT 1 FROM json_each(${p}.availability_json,'$.reasons') WHERE value='missing_parent')`,
        ],
        [
          "deferred",
          `(SELECT count(*) FROM json_each(${p}.deferred_json) WHERE json_extract(value,'$.state')!='ready')`,
        ],
      ],
    },
    {
      table: "memory_outbox",
      columns: "space,kind,status,metadata_json",
      values: (p: string) => [
        [
          "pending_sync",
          `(${p}.kind IN ('sync','revert_intent') OR (${p}.kind='admin' AND ${p}.space='_local:'||json_extract(${p}.metadata_json,'$.environmentId') AND json_extract(${p}.metadata_json,'$.kind')='localIntent')) AND ${p}.status IN ('pending','retry','running')`,
        ],
      ],
    },
    {
      table: "memory_inbox_pending",
      columns: "space,record_kind",
      values: (p: string) => [["parked", `${p}.record_kind='operation'`]],
    },
    {
      table: "memory_report_outbox",
      columns: "space,state",
      values: (p: string) => [
        ["report_backlog", `${p}.state IN ('pending','failed')`],
        ["report_failed", `${p}.state='failed'`],
      ],
    },
    // The event and compact forms of a refusal count once across compaction.
    {
      table: "memory_events",
      columns: "memory_space_id,operation_id,receipt_json",
      values: (p: string) => [
        [
          "admission_failures",
          `json_extract(${p}.receipt_json,'$.outcome')='rejected' AND NOT EXISTS(SELECT 1 FROM memory_compact_receipts c WHERE c.space=${p}.memory_space_id AND c.operation_id=${p}.operation_id)`,
        ],
      ],
    },
    {
      table: "memory_compact_receipts",
      columns: "space,operation_id,receipt_json",
      values: (p: string) => [
        [
          "admission_failures",
          `(json_extract(${p}.receipt_json,'$.outcome')='rejected')-EXISTS(SELECT 1 FROM memory_events e WHERE e.memory_space_id=${p}.space AND e.operation_id=${p}.operation_id AND json_extract(e.receipt_json,'$.outcome')='rejected')`,
        ],
      ],
    },
  ];
  for (const entry of processingInventory) {
    const spaceColumn = entry.table === "memory_events" ? "memory_space_id" : "space";
    if (entry.table === "memory_items") {
      // Materialize one GROUP BY, then expand the eight scalars without rescanning items.
      const pairs = entry
        .values("seed")
        .map(
          ([dimension, expression]) =>
            `'processing_${dimension}',coalesce(sum(coalesce((${expression}),0)),0)`,
        )
        .join(",");
      yield* sql.unsafe(`WITH totals AS MATERIALIZED (
        SELECT seed.space,json_object(${pairs}) AS counters FROM memory_items seed GROUP BY seed.space
      ) INSERT INTO memory_quota_counters(space,dimension,scope_key,value)
        SELECT totals.space,c.key,'',c.value FROM totals,json_each(totals.counters) c WHERE 1
        ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=value+excluded.value`);
    } else {
      for (const [dimension, originalExpression] of entry.values("seed")) {
        const expression =
          entry.table === "memory_compact_receipts"
            ? "json_extract(seed.receipt_json,'$.outcome')='rejected'"
            : originalExpression;
        yield* sql.unsafe(
          `INSERT INTO memory_quota_counters(space,dimension,scope_key,value) SELECT seed.${spaceColumn},'processing_${dimension}','',coalesce(sum(coalesce((${expression}),0)),0) FROM ${entry.table} seed GROUP BY seed.${spaceColumn} ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=value+excluded.value`,
        );
      }
    }
    const delta = (p: string, sign: number) =>
      entry
        .values(p)
        .map(([dimension, expression]) =>
          sign < 0
            ? `UPDATE memory_quota_counters SET value=value-coalesce((${expression}),0) WHERE space=${p}.${spaceColumn} AND dimension='processing_${dimension}' AND scope_key='';`
            : `INSERT INTO memory_quota_counters(space,dimension,scope_key,value) VALUES (${p}.${spaceColumn},'processing_${dimension}','',coalesce((${expression}),0)) ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=value+excluded.value;`,
        )
        .join("\n");
    for (const action of ["INSERT", "UPDATE", "DELETE"] as const) {
      if (entry.table === "memory_items" && action === "UPDATE") {
        const oldValues = entry.values("OLD");
        const updates = entry
          .values("NEW")
          .map(([dimension, expression], index) => {
            const previous = oldValues[index]![1];
            const next = `coalesce((${expression}),0)`;
            const old = `coalesce((${previous}),0)`;
            return `UPDATE memory_quota_counters SET value=value+${next}-${old}
            WHERE space=NEW.space AND dimension='processing_${dimension}' AND scope_key='' AND ${next}!=${old};`;
          })
          .join("\n");
        yield* sql.unsafe(
          `CREATE TRIGGER memory_items_processing_update AFTER UPDATE OF ${entry.columns} ON memory_items WHEN NEW.space=OLD.space BEGIN ${updates} END`,
        );
        // Space moves are rare; keep subtraction/addition out of the normal path.
        yield* sql.unsafe(
          `CREATE TRIGGER memory_items_processing_move AFTER UPDATE OF space ON memory_items WHEN NEW.space!=OLD.space BEGIN ${delta("OLD", -1)} ${delta("NEW", 1)} END`,
        );
      } else {
        yield* sql.unsafe(
          `CREATE TRIGGER ${entry.table}_processing_${action.toLowerCase()} AFTER ${action}${action === "UPDATE" ? ` OF ${entry.columns}` : ""} ON ${entry.table} BEGIN ${action !== "INSERT" ? delta("OLD", -1) : ""} ${action !== "DELETE" ? delta("NEW", 1) : ""} END`,
        );
      }
    }
  }

  // Six deferred kinds, one per kind. A virtual scalar and narrow partial
  // index give the exact oldest row without another writer UPDATE or body index.
  const noDeferred = "9999-12-31T23:59:59.999Z";
  const deferredTimes = Array.from(
    { length: 6 },
    (_, slot) =>
      `coalesce(CASE WHEN json_extract(deferred_json,'$[${slot}].state')!='ready' THEN json_extract(deferred_json,'$[${slot}].sinceAtUtc') END,'${noDeferred}')`,
  ).join(",");
  yield* sql.unsafe(
    `ALTER TABLE memory_items ADD COLUMN processing_oldest_at TEXT GENERATED ALWAYS AS (nullif(min(${deferredTimes}),'${noDeferred}')) VIRTUAL`,
  );
  yield* sql`CREATE INDEX memory_processing_oldest ON memory_items(space,processing_oldest_at) WHERE processing_oldest_at IS NOT NULL`;
});
