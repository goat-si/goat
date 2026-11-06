import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { refreshCheckpointAccounting } from "../../memory/MemoryCheckpointAccounting.ts";

/** Additive upgrade: old publications and pinned pages are immutable. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE memory_import_noop_results (
    space TEXT NOT NULL, environment_id TEXT NOT NULL, source_id TEXT NOT NULL,
    result_ref TEXT NOT NULL, codec_version INTEGER NOT NULL CHECK(codec_version=1),
    result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(CAST(result_json AS BLOB))<=65536),
    PRIMARY KEY(space,environment_id,source_id,result_ref)
  )`;
  yield* sql`ALTER TABLE memory_import_receipts ADD COLUMN result_ref TEXT`;
  yield* sql`CREATE INDEX memory_import_batch_result ON memory_import_receipts(space,environment_id,source_id,result_ref) WHERE result_ref IS NOT NULL`;
  for (const action of ["INSERT", "UPDATE"] as const)
    yield* sql.unsafe(`CREATE TRIGGER memory_import_result_ref_${action.toLowerCase()} BEFORE ${action} ON memory_import_receipts
      WHEN (json_extract(NEW.completed_items_json,'$.kind')='completed-noop-ref' AND NEW.result_ref IS NULL) OR NEW.result_ref IS NOT NULL AND (NEW.record_kind!='batch' OR json_extract(NEW.completed_items_json,'$.kind') IS NOT 'completed-noop-ref' OR json_extract(NEW.completed_items_json,'$.resultRef') IS NOT NEW.result_ref OR NOT EXISTS(SELECT 1 FROM memory_import_noop_results r WHERE r.space=NEW.space AND r.environment_id=NEW.environment_id AND r.source_id=NEW.source_id AND r.result_ref=NEW.result_ref))
      BEGIN SELECT RAISE(ABORT,'invalid import result reference'); END`);
  yield* sql`CREATE TRIGGER memory_import_result_delete BEFORE DELETE ON memory_import_noop_results
    WHEN EXISTS(SELECT 1 FROM memory_import_receipts b WHERE b.space=OLD.space AND b.environment_id=OLD.environment_id AND b.source_id=OLD.source_id AND b.result_ref=OLD.result_ref)
    BEGIN SELECT RAISE(ABORT,'referenced import result'); END`;
  yield* sql`CREATE TRIGGER memory_import_result_immutable BEFORE UPDATE ON memory_import_noop_results
    BEGIN SELECT RAISE(ABORT,'immutable import result'); END`;

  // Preserve the legacy raw input meter for unbound local work. It is NOT U_next.
  yield* sql`INSERT INTO memory_quota_counters(space,dimension,scope_key,value) SELECT space,'memory_input_bytes',scope_key,value FROM memory_quota_counters WHERE dimension='hub_snapshot_bytes'`;
  const definitions = yield* sql<{
    name: string;
    sql: string;
  }>`SELECT name,sql FROM sqlite_master WHERE type='trigger'`;
  for (const trigger of definitions) {
    if (
      /^memory_.*_hub_snapshot_(bytes|rows)_(insert|update|delete)$/.test(trigger.name) ||
      trigger.name.startsWith("memory_tombstones_snapshot_forget_")
    ) {
      yield* sql.unsafe(`DROP TRIGGER ${trigger.name}`);
      if (trigger.name.includes("_hub_snapshot_bytes_"))
        yield* sql.unsafe(trigger.sql.replaceAll("hub_snapshot_bytes", "memory_input_bytes"));
    } else if (/^memory_import_lineage_(insert|update|delete)$/.test(trigger.name)) {
      // Keep permanent lineage/first-forget charge and generation invalidation.
      const rewritten = trigger.sql.replace(
        /(?:INSERT INTO memory_quota_counters\(space,dimension,scope_key,value\)\s+VALUES \([^;]+?'hub_snapshot_(?:bytes|rows)'[^;]+?;|UPDATE memory_quota_counters SET value=[^;]+?dimension='hub_snapshot_(?:bytes|rows)'[^;]*;)/g,
        "",
      );
      yield* sql.unsafe(`DROP TRIGGER ${trigger.name}`);
      yield* sql.unsafe(rewritten);
    }
  }
  const counter = (space: string, dimension: string, value: string) =>
    value.startsWith("-")
      ? `UPDATE memory_quota_counters SET value=value+(${value}) WHERE space=${space} AND dimension='${dimension}' AND scope_key='';`
      : `INSERT INTO memory_quota_counters(space,dimension,scope_key,value) VALUES (${space},'${dimension}','',${value}) ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=value+excluded.value;`;
  // Cursor retry is private scheduling metadata, not a canonical checkpoint record.
  yield* sql.unsafe(
    counter(
      "'_hub_global'",
      "hub_metadata",
      "(SELECT coalesce(sum(length(CAST(pull_retry_json AS BLOB))),0) FROM memory_sync_cursors)",
    ),
  );
  yield* sql.unsafe(
    counter(
      "'_hub_global'",
      "hub_private_metadata",
      "(SELECT coalesce(sum(length(CAST(pull_retry_json AS BLOB))),0) FROM memory_sync_cursors)",
    ),
  );
  for (const action of ["INSERT", "UPDATE", "DELETE"] as const) {
    const delta = (p: string, sign: number) =>
      ["hub_metadata", "hub_private_metadata"]
        .map((d) =>
          counter(
            "'_hub_global'",
            d,
            `${sign}*coalesce(length(CAST(${p}.pull_retry_json AS BLOB)),0)`,
          ),
        )
        .join("");
    yield* sql.unsafe(
      `CREATE TRIGGER memory_sync_cursors_private_${action.toLowerCase()} AFTER ${action} ON memory_sync_cursors BEGIN ${action !== "INSERT" ? delta("OLD", -1) : ""}${action !== "DELETE" ? delta("NEW", 1) : ""} END`,
    );
  }
  // Replace origin triggers as one unit, retaining every private admission dimension.
  const columns =
    "receipt_id,space,environment_id,record_kind,source_id,format,source_locator,source_item_key,parser_version,scope_json,accepted_source_fingerprint,accepted_content_fingerprints_json,observed_rejected_fingerprint,memory_id,accepted_revision_id,batch_operation_id,request_digest,completed_items_json,outcome,issue,observed_at_utc,source_aliases_json,registration_json,result_ref".split(
      ",",
    );
  const raw = (p: string) =>
    columns.map((c) => `coalesce(length(CAST(${p}${c} AS BLOB)),0)`).join("+");
  const metrics = [
    [
      "import_metadata",
      (p: string) =>
        `(${raw(p)})+CASE WHEN ${p}record_kind='batch' THEN ${M.MEMORY_COMPACT_RECEIPT_MAX_BYTES} ELSE 0 END`,
    ],
    [
      "import_staging",
      (p: string) =>
        `CASE WHEN ${p}record_kind='batch' AND json_extract(${p}completed_items_json,'$.kind') IN ('detailed','completed-noop-ref') THEN coalesce(length(CAST(${p}completed_items_json AS BLOB)),0) ELSE 0 END`,
    ],
    ["import_receipts", (p: string) => `CASE WHEN ${p}record_kind='batch' THEN 1 ELSE 0 END`],
    ["import_sources", (p: string) => `CASE WHEN ${p}record_kind='source' THEN 1 ELSE 0 END`],
    ["import_source_items", (p: string) => `CASE WHEN ${p}record_kind='item' THEN 1 ELSE 0 END`],
    ["import_aliases", (p: string) => `CASE WHEN ${p}record_kind='item' THEN 1 ELSE 0 END`],
    [
      "import_digests",
      (p: string) =>
        `CASE WHEN ${p}record_kind='item' THEN coalesce(json_array_length(${p}accepted_content_fingerprints_json),0) ELSE 0 END`,
    ],
  ] as const;
  const receiptDelta = (p: string, sign: number) =>
    metrics
      .map(
        ([d, expression]) =>
          counter("'_hub_global'", d, `${sign}*(${expression(p + ".")})`) +
          counter(`${p}.space`, d, `${sign}*(${expression(p + ".")})`),
      )
      .join("") +
    counter(
      "'_hub_global'",
      "hub_receipts",
      `${sign}*(CASE WHEN ${p}.record_kind='batch' THEN 1 ELSE 0 END)`,
    ) +
    counter("'_hub_global'", "hub_metadata", `${sign}*(${metrics[0][1](p + ".")})`) +
    counter("'_hub_global'", "hub_private_metadata", `${sign}*(${metrics[0][1](p + ".")})`);
  for (const action of ["INSERT", "UPDATE", "DELETE"] as const) {
    yield* sql.unsafe(`DROP TRIGGER memory_import_receipts_origin_${action.toLowerCase()}`);
    yield* sql.unsafe(
      `CREATE TRIGGER memory_import_receipts_origin_${action.toLowerCase()} AFTER ${action} ON memory_import_receipts ${action === "UPDATE" ? `WHEN ${columns.map((c) => `OLD.${c} IS NOT NEW.${c}`).join(" OR ")}` : ""} BEGIN ${action !== "INSERT" ? receiptDelta("OLD", -1) : ""}${action !== "DELETE" ? receiptDelta("NEW", 1) : ""} END`,
    );
  }
  // Unique template bytes are charged once; each operation retains its own guard charge above.
  for (const [action, p, sign] of [
    ["INSERT", "NEW", 1],
    ["DELETE", "OLD", -1],
  ] as const) {
    const bytes = `${sign}*(length(CAST(${p}.result_json AS BLOB))+length(CAST(${p}.result_ref AS BLOB))+length(CAST(${p}.space AS BLOB))+length(CAST(${p}.environment_id AS BLOB))+length(CAST(${p}.source_id AS BLOB))+8)`;
    yield* sql.unsafe(
      `CREATE TRIGGER memory_import_noop_results_${action.toLowerCase()} AFTER ${action} ON memory_import_noop_results BEGIN ${["hub_metadata", "hub_private_metadata", "import_metadata", "import_staging"].map((d) => counter("'_hub_global'", d, bytes)).join("")}${["import_metadata", "import_staging"].map((d) => counter(`${p}.space`, d, bytes)).join("")} END`,
    );
  }
  // Private rows do not produce records. Outbox only affects the embedded pendingSync bit.
  for (const table of [
    "memory_events",
    "memory_hub_members",
    "memory_hub_leases",
    "memory_hub_source_reads",
  ])
    for (const action of ["insert", "update", "delete"])
      yield* sql.unsafe(`DROP TRIGGER IF EXISTS ${table}_snapshot_generation_${action}`);

  // All canonical record caches keep two numeric sizes on their existing row. Do not
  // duplicate source keys into an index/cache table. Rowid invalidations are
  // transaction-local and are always drained before commit.
  for (const table of [
    "memory_identity_ledger",
    "memory_compact_receipts",
    "memory_import_lineage",
    "memory_import_keys",
  ]) {
    yield* sql.unsafe(
      `ALTER TABLE ${table} ADD COLUMN checkpoint_bytes INTEGER NOT NULL DEFAULT 0 CHECK(checkpoint_bytes>=0)`,
    );
    yield* sql.unsafe(
      `ALTER TABLE ${table} ADD COLUMN checkpoint_rows INTEGER NOT NULL DEFAULT 0 CHECK(checkpoint_rows>=0)`,
    );
    const requireTotal = `SELECT CASE WHEN
      (OLD.checkpoint_bytes>0 AND NOT EXISTS(SELECT 1 FROM memory_quota_counters WHERE space=OLD.space AND dimension='hub_snapshot_bytes' AND scope_key='')) OR
      (OLD.checkpoint_rows>0 AND NOT EXISTS(SELECT 1 FROM memory_quota_counters WHERE space=OLD.space AND dimension='hub_snapshot_rows' AND scope_key=''))
      THEN RAISE(ABORT,'missing checkpoint total') END;`;
    yield* sql.unsafe(`CREATE TRIGGER ${table}_checkpoint_release BEFORE DELETE ON ${table} BEGIN
      ${requireTotal}
      UPDATE memory_quota_counters SET value=value-OLD.checkpoint_bytes WHERE space=OLD.space AND dimension='hub_snapshot_bytes' AND scope_key='';
      UPDATE memory_quota_counters SET value=value-OLD.checkpoint_rows WHERE space=OLD.space AND dimension='hub_snapshot_rows' AND scope_key='';
    END`);
    yield* sql.unsafe(`CREATE TRIGGER ${table}_checkpoint_move AFTER UPDATE OF space ON ${table} WHEN OLD.space IS NOT NEW.space BEGIN
      ${requireTotal}
      UPDATE memory_quota_counters SET value=value-OLD.checkpoint_bytes WHERE space=OLD.space AND dimension='hub_snapshot_bytes' AND scope_key='';
      UPDATE memory_quota_counters SET value=value-OLD.checkpoint_rows WHERE space=OLD.space AND dimension='hub_snapshot_rows' AND scope_key='';
      UPDATE ${table} SET checkpoint_bytes=0,checkpoint_rows=0 WHERE rowid=NEW.rowid;
    END`);
  }
  // These indexes contain bounded aggregate/owner addresses, never corpus text.
  yield* sql`CREATE INDEX memory_checkpoint_spaces ON memory_quota_counters(space) WHERE (dimension='hub_snapshot_rows' OR dimension='checkpoint_initialized' OR dimension='hub_snapshot_bytes') AND scope_key=''`;
  yield* sql`CREATE INDEX memory_suppression_owner ON memory_import_keys(space,memory_id) WHERE key_kind IN ('sourceKey','content','sourceExclusion')`;
  // Invalidation keys use only the existing quota counter PK, and are drained
  // synchronously inside the writer transaction before admission/publication/commit.
  const mark = (space: string, key: string) =>
    `INSERT INTO memory_quota_counters(space,dimension,scope_key,value) VALUES ('_checkpoint_dirty',${space},${key},1) ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=1;`;
  const related = (p: string) => `
    INSERT INTO memory_quota_counters(space,dimension,scope_key,value)
    SELECT '_checkpoint_dirty',space,'l:'||rowid,1 FROM memory_import_lineage WHERE space=${p}.space AND memory_id=${p}.memory_id
    ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=1;
    INSERT INTO memory_quota_counters(space,dimension,scope_key,value)
    SELECT '_checkpoint_dirty',space,'s:'||rowid,1 FROM memory_import_keys WHERE space=${p}.space AND memory_id=${p}.memory_id AND key_kind IN ('sourceKey','content','sourceExclusion')
    ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=1;`;
  for (const table of [
    "memory_items",
    "memory_revisions",
    "memory_payloads",
    "memory_tombstones",
    "memory_conflicts",
    "memory_resolutions",
    "memory_identity_ledger",
    "memory_import_lineage",
    "memory_import_keys",
    "memory_outbox",
    "memory_compact_receipts",
  ])
    for (const action of ["INSERT", "UPDATE", "DELETE"] as const) {
      const prefixes = action === "UPDATE" ? ["OLD", "NEW"] : [action === "DELETE" ? "OLD" : "NEW"];
      const body = prefixes
        .map((p) =>
          table === "memory_compact_receipts"
            ? mark(`${p}.space`, `'c:'||${p}.operation_id`)
            : table === "memory_import_lineage"
              ? mark(`${p}.space`, `'l:'||${p}.rowid`)
              : table === "memory_import_keys"
                ? mark(`${p}.space`, `'s:'||${p}.rowid`)
                : mark(`${p}.space`, `'m:'||${p}.memory_id`) +
                  ((table === "memory_identity_ledger" || table === "memory_tombstones") &&
                  action !== "UPDATE"
                    ? related(p)
                    : ""),
        )
        .join("");
      const when =
        table === "memory_import_keys"
          ? `${action === "UPDATE" ? "OLD.key_kind IN ('sourceKey','content','sourceExclusion') OR NEW" : prefixes[0]}.key_kind IN ('sourceKey','content','sourceExclusion')`
          : table === "memory_outbox"
            ? `${prefixes[0]}.memory_id IS NOT NULL AND ${prefixes[0]}.kind IN ('sync','revert_intent')`
            : undefined;
      yield* sql.unsafe(
        `CREATE TRIGGER ${table}_checkpoint_codec_${action.toLowerCase()} AFTER ${action} ON ${table} ${when ? `WHEN ${when}` : ""} BEGIN ${body} END`,
      );
    }
  // One-time full recalc uses the very same selector/encoder as later per-key deltas.
  // Remember legacy spaces even when their canonical inventory is empty. The
  // marker and both recalculated totals commit atomically with this unreleased upgrade.
  yield* sql`INSERT INTO memory_quota_counters(space,dimension,scope_key,value)
    SELECT space,'checkpoint_initialized','',1 FROM
      (SELECT space FROM memory_quota_counters WHERE dimension IN ('hub_snapshot_bytes','hub_snapshot_rows') AND scope_key=''
       UNION SELECT space FROM memory_hub_retention)`;
  yield* sql`DELETE FROM memory_quota_counters WHERE dimension IN ('hub_snapshot_bytes','hub_snapshot_rows')`;
  for (const dimension of ["hub_snapshot_bytes", "hub_snapshot_rows"])
    yield* sql`INSERT INTO memory_quota_counters(space,dimension,scope_key,value)
      SELECT space,${dimension},'',0 FROM memory_quota_counters WHERE dimension='checkpoint_initialized' AND scope_key=''`;
  yield* sql`INSERT INTO memory_quota_counters(space,dimension,scope_key,value) SELECT '_checkpoint_dirty',space,'m:'||memory_id,1 FROM memory_identity_ledger`;
  yield* sql`INSERT INTO memory_quota_counters(space,dimension,scope_key,value) SELECT '_checkpoint_dirty',space,'c:'||operation_id,1 FROM memory_compact_receipts`;
  yield* sql`INSERT INTO memory_quota_counters(space,dimension,scope_key,value) SELECT '_checkpoint_dirty',space,'l:'||rowid,1 FROM memory_import_lineage`;
  yield* sql`INSERT INTO memory_quota_counters(space,dimension,scope_key,value) SELECT '_checkpoint_dirty',space,'s:'||rowid,1 FROM memory_import_keys WHERE key_kind IN ('sourceKey','content','sourceExclusion')`;
  yield* sql`INSERT INTO memory_quota_counters(space,dimension,scope_key,value) VALUES ('_hub_global','checkpoint_codec','',1)`;
  yield* refreshCheckpointAccounting("recompute");
});
