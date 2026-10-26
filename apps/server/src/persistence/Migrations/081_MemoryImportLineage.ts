import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Lifetime evidence is independent of revisions, receipt retention and payload deletion. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE memory_import_lineage (
    space TEXT NOT NULL, memory_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('sourceKey','content')), key TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK(json_valid(record_json)),
    PRIMARY KEY(space,memory_id,kind,key)
  )`;
  // Exact-copy/source lookup cannot use the per-memory primary-key prefix.
  yield* sql`CREATE INDEX memory_import_lineage_lookup ON memory_import_lineage(space,kind,key,memory_id)`;
  yield* sql`INSERT INTO memory_quota_counters(space,dimension,scope_key,value)
    VALUES ('_hub_global','import_lineage_bytes','',0)`;
  const counter = (space: string, dimension: string, value: string) =>
    value.startsWith("-")
      ? `UPDATE memory_quota_counters SET value=value+(${value}) WHERE space=${space} AND dimension='${dimension}' AND scope_key='';`
      : `
    INSERT INTO memory_quota_counters(space,dimension,scope_key,value)
    VALUES (${space},'${dimension}','',${value})
    ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=value+excluded.value;`;
  const delta = (p: string, sign: number) => {
    const bytes = `length(CAST(${p}.record_json AS BLOB))`;
    // A suppression adds a bounded UUID deleteOperationId to the exact lineage record.
    // 64 bytes covers its JSON field, quotes, comma and the 36-byte operation ID.
    const reserve = `(${bytes}+64)`;
    return (
      counter("'_hub_global'", "import_lineage_bytes", `${sign}*${bytes}`) +
      counter("'_hub_global'", "hub_metadata", `${sign}*${bytes}`) +
      counter(`${p}.space`, "hub_snapshot_bytes", `${sign}*${bytes}`) +
      counter(`${p}.space`, "hub_snapshot_rows", `${sign}`) +
      `
      UPDATE memory_identity_ledger SET reserve_bytes=reserve_bytes+${sign}*${reserve},
        reserve_keys=reserve_keys+${sign}
      WHERE space=${p}.space AND memory_id=${p}.memory_id AND NOT EXISTS
        (SELECT 1 FROM memory_tombstones t WHERE t.space=${p}.space AND t.memory_id=${p}.memory_id);`
    );
  };
  const invalidate = (space: string) => `
    UPDATE memory_hub_retention SET published_pinned_bytes=published_pinned_bytes-
      (SELECT coalesce(sum(length(CAST(p.metadata_json AS BLOB))),0) FROM memory_inbox_pending p
       WHERE p.space=memory_hub_retention.space AND p.reason='hub_snapshot' AND p.checkpoint_id='hub:'||reserved_snapshot_id)
    WHERE space=${space} AND reserved_snapshot_id IS NOT NULL AND checkpoint_id IS NOT reserved_snapshot_id
      AND NOT EXISTS(SELECT 1 FROM json_each(handles_json) h WHERE json_extract(h.value,'$.checkpointId')=reserved_snapshot_id);
    DELETE FROM memory_inbox_pending WHERE space=${space} AND reason='hub_snapshot' AND checkpoint_id IN
      (SELECT 'hub:'||reserved_snapshot_id FROM memory_hub_retention WHERE space=${space}
       AND reserved_snapshot_id IS NOT NULL AND checkpoint_id IS NOT reserved_snapshot_id
       AND NOT EXISTS(SELECT 1 FROM json_each(handles_json) h WHERE json_extract(h.value,'$.checkpointId')=reserved_snapshot_id));
    UPDATE memory_hub_retention SET reserved_snapshot_id=NULL,snapshot_generation=-1
    WHERE space=${space} AND reserved_snapshot_id IS NOT NULL AND checkpoint_id IS NOT reserved_snapshot_id
      AND NOT EXISTS(SELECT 1 FROM json_each(handles_json) h WHERE json_extract(h.value,'$.checkpointId')=reserved_snapshot_id);
    ${counter(space, "hub_snapshot_generation", "1")}`;
  for (const [action, body] of [
    ["INSERT", delta("NEW", 1) + invalidate("NEW.space")],
    [
      "UPDATE",
      delta("OLD", -1) + delta("NEW", 1) + invalidate("OLD.space") + invalidate("NEW.space"),
    ],
    ["DELETE", delta("OLD", -1) + invalidate("OLD.space")],
  ] as const) {
    yield* sql.unsafe(`CREATE TRIGGER memory_import_lineage_${action.toLowerCase()} AFTER ${action}
      ON memory_import_lineage ${action === "UPDATE" ? "WHEN OLD.space IS NOT NEW.space OR OLD.memory_id IS NOT NEW.memory_id OR OLD.kind IS NOT NEW.kind OR OLD.key IS NOT NEW.key OR OLD.record_json IS NOT NEW.record_json" : ""}
      BEGIN ${body} END`);
  }
  // Origin-only import envelopes are private metadata, but consume the same global
  // permanent/staging pool and producer reservation as the 071 inventory.
  const importColumns =
    "receipt_id,space,environment_id,record_kind,source_id,format,source_locator,source_item_key,parser_version,scope_json,accepted_source_fingerprint,accepted_content_fingerprints_json,observed_rejected_fingerprint,memory_id,accepted_revision_id,batch_operation_id,request_digest,completed_items_json,outcome,issue,observed_at_utc,source_aliases_json,registration_json".split(
      ",",
    );
  const rawBytes = (p: string) =>
    importColumns.map((c) => `coalesce(length(CAST(${p}${c} AS BLOB)),0)`).join("+");
  // Reserve a compact replay guard at first allocation. Retirement never competes
  // for a fresh slot after the detail has expired.
  const guardBytes = (p: string) =>
    `CASE WHEN ${p}record_kind='batch' THEN ${M.MEMORY_COMPACT_RECEIPT_MAX_BYTES} ELSE 0 END`;
  const stagingBytes = (p: string) =>
    `CASE WHEN ${p}record_kind='batch' AND json_extract(${p}completed_items_json,'$.kind')='detailed' THEN coalesce(length(CAST(${p}completed_items_json AS BLOB)),0) ELSE 0 END`;
  const metrics = [
    ["import_metadata", (p: string) => `(${rawBytes(p)})+(${guardBytes(p)})`],
    ["import_staging", stagingBytes],
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
  for (const [dimension, expression] of metrics) {
    yield* sql.unsafe(`INSERT INTO memory_quota_counters(space,dimension,scope_key,value)
      SELECT '_hub_global','${dimension}','',coalesce(sum(${expression("")}),0) FROM memory_import_receipts`);
    yield* sql.unsafe(`INSERT INTO memory_quota_counters(space,dimension,scope_key,value)
      SELECT space,'${dimension}','',sum(${expression("")}) FROM memory_import_receipts GROUP BY space`);
  }
  const total = `(SELECT coalesce(sum((${rawBytes("")})+(${guardBytes("")})),0) FROM memory_import_receipts)`;
  yield* sql.unsafe(counter("'_hub_global'", "hub_metadata", total));
  yield* sql.unsafe(counter("'_hub_global'", "hub_private_metadata", total));
  yield* sql.unsafe(`INSERT INTO memory_quota_counters(space,dimension,scope_key,value)
    SELECT space,'hub_snapshot_bytes','',sum((${rawBytes("")})+(${guardBytes("")})) FROM memory_import_receipts GROUP BY space
    ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=value+excluded.value`);
  yield* sql.unsafe(`INSERT INTO memory_quota_counters(space,dimension,scope_key,value)
    SELECT space,'hub_snapshot_rows','',count(*) FROM memory_import_receipts GROUP BY space
    ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=value+excluded.value`);
  yield* sql.unsafe(
    counter(
      "'_hub_global'",
      "hub_receipts",
      `(SELECT count(*) FROM memory_import_receipts WHERE record_kind='batch')`,
    ),
  );
  const receiptDelta = (p: string, sign: number) => {
    const bytes = `((${rawBytes(p + ".")})+(${guardBytes(p + ".")}))`;
    return (
      metrics
        .map(
          ([dimension, expression]) =>
            counter("'_hub_global'", dimension, `${sign}*(${expression(p + ".")})`) +
            counter(`${p}.space`, dimension, `${sign}*(${expression(p + ".")})`),
        )
        .join("") +
      counter(
        "'_hub_global'",
        "hub_receipts",
        `${sign}*(CASE WHEN ${p}.record_kind='batch' THEN 1 ELSE 0 END)`,
      ) +
      counter("'_hub_global'", "hub_metadata", `${sign}*${bytes}`) +
      counter("'_hub_global'", "hub_private_metadata", `${sign}*${bytes}`) +
      counter(`${p}.space`, "hub_snapshot_bytes", `${sign}*${bytes}`) +
      counter(`${p}.space`, "hub_snapshot_rows", `${sign}`)
    );
  };
  for (const [action, body] of [
    ["INSERT", receiptDelta("NEW", 1) + invalidate("NEW.space")],
    ["UPDATE", receiptDelta("OLD", -1) + receiptDelta("NEW", 1) + invalidate("NEW.space")],
    ["DELETE", receiptDelta("OLD", -1) + invalidate("OLD.space")],
  ] as const)
    yield* sql.unsafe(`CREATE TRIGGER memory_import_receipts_origin_${action.toLowerCase()} AFTER ${action} ON memory_import_receipts
    ${action === "UPDATE" ? `WHEN ${importColumns.map((c) => `OLD.${c} IS NOT NEW.${c}`).join(" OR ")}` : ""}
    BEGIN ${body} END`);
  // These indexed probes never scan all imports for an item's generic edit/forget.
  yield* sql`CREATE INDEX memory_import_item_memory ON memory_import_receipts(space,memory_id) WHERE record_kind='item'`;
  const owned = (space: string, id: string) =>
    `EXISTS(SELECT 1 FROM memory_import_receipts r WHERE r.space=${space} AND r.memory_id=${id} AND r.record_kind='item')`;
  const liveCount = (p: string) => `CASE WHEN ${p}.status!='forgotten' THEN 1 ELSE 0 END`;
  const liveBytes = (p: string) =>
    `CASE WHEN ${p}.status='forgotten' THEN 0 ELSE (SELECT coalesce(sum(length(CAST(json_extract(b.body_json,'$.text') AS BLOB))),0) FROM memory_payloads b WHERE b.space=${p}.space AND b.payload_ref IN (SELECT v.payload_ref FROM json_each(${p}.heads_json) h JOIN memory_revisions v ON v.space=${p}.space AND v.revision_id=h.value)) END`;
  const liveDelta = (count: string, bytes: string, sign: number) =>
    counter("'_hub_global'", "import_live_items", `${sign}*(${count})`) +
    counter("'_hub_global'", "import_live_bytes", `${sign}*(${bytes})`);
  for (const [dimension, expression] of [
    ["import_live_items", liveCount("i")],
    ["import_live_bytes", liveBytes("i")],
  ] as const)
    yield* sql.unsafe(`INSERT INTO memory_quota_counters(space,dimension,scope_key,value)
      SELECT '_hub_global','${dimension}','',coalesce(sum(${expression}),0) FROM memory_items i WHERE ${owned("i.space", "i.memory_id")}`);
  for (const [action, body] of [
    ["INSERT", liveDelta(liveCount("NEW"), liveBytes("NEW"), 1)],
    [
      "UPDATE",
      liveDelta(liveCount("OLD"), liveBytes("OLD"), -1) +
        liveDelta(liveCount("NEW"), liveBytes("NEW"), 1),
    ],
    ["DELETE", liveDelta(liveCount("OLD"), liveBytes("OLD"), -1)],
  ] as const) {
    const p = action === "DELETE" ? "OLD" : "NEW";
    yield* sql.unsafe(
      `CREATE TRIGGER memory_items_import_${action.toLowerCase()} AFTER ${action} ON memory_items WHEN ${owned(p + ".space", p + ".memory_id")} BEGIN ${body} END`,
    );
  }
  // Purge deletes dependent bodies before publishing their blocked projection.
  // Release the still-live head charge while OLD body bytes remain available;
  // the later item update sees no payload and therefore cannot release it twice.
  yield* sql.unsafe(`CREATE TRIGGER memory_payloads_import_live_delete BEFORE DELETE ON memory_payloads
    WHEN ${owned("OLD.space", "OLD.memory_id")}
    BEGIN ${counter("'_hub_global'", "import_live_bytes", `-coalesce(length(CAST(json_extract(OLD.body_json,'$.text') AS BLOB)),0) * (SELECT count(*) FROM memory_items i WHERE i.space=OLD.space AND i.memory_id=OLD.memory_id AND i.status!='forgotten' AND EXISTS(SELECT 1 FROM json_each(i.heads_json) h JOIN memory_revisions v ON v.space=i.space AND v.revision_id=h.value WHERE v.payload_ref=OLD.payload_ref))`)} END`);
  const mappedDelta = (p: string, sign: number) =>
    liveDelta(
      `(SELECT coalesce(sum(${liveCount("i")}),0) FROM memory_items i WHERE i.space=${p}.space AND i.memory_id=${p}.memory_id)`,
      `(SELECT coalesce(sum(${liveBytes("i")}),0) FROM memory_items i WHERE i.space=${p}.space AND i.memory_id=${p}.memory_id)`,
      sign,
    );
  yield* sql.unsafe(`CREATE TRIGGER memory_import_receipts_import_live_insert AFTER INSERT ON memory_import_receipts
    WHEN NEW.record_kind='item' AND (SELECT count(*) FROM memory_import_receipts r WHERE r.space=NEW.space AND r.memory_id=NEW.memory_id AND r.record_kind='item')=1
    BEGIN ${mappedDelta("NEW", 1)} END`);
  yield* sql.unsafe(`CREATE TRIGGER memory_import_receipts_import_live_update AFTER UPDATE OF memory_id ON memory_import_receipts
    WHEN NEW.record_kind='item' AND OLD.memory_id IS NOT NEW.memory_id
    BEGIN
      ${liveDelta(`CASE WHEN NOT EXISTS(SELECT 1 FROM memory_import_receipts r WHERE r.space=OLD.space AND r.memory_id=OLD.memory_id AND r.record_kind='item') THEN (SELECT coalesce(sum(${liveCount("i")}),0) FROM memory_items i WHERE i.space=OLD.space AND i.memory_id=OLD.memory_id) ELSE 0 END`, `CASE WHEN NOT EXISTS(SELECT 1 FROM memory_import_receipts r WHERE r.space=OLD.space AND r.memory_id=OLD.memory_id AND r.record_kind='item') THEN (SELECT coalesce(sum(${liveBytes("i")}),0) FROM memory_items i WHERE i.space=OLD.space AND i.memory_id=OLD.memory_id) ELSE 0 END`, -1)}
      ${liveDelta(`CASE WHEN (SELECT count(*) FROM memory_import_receipts r WHERE r.space=NEW.space AND r.memory_id=NEW.memory_id AND r.record_kind='item')=1 THEN (SELECT coalesce(sum(${liveCount("i")}),0) FROM memory_items i WHERE i.space=NEW.space AND i.memory_id=NEW.memory_id) ELSE 0 END`, `CASE WHEN (SELECT count(*) FROM memory_import_receipts r WHERE r.space=NEW.space AND r.memory_id=NEW.memory_id AND r.record_kind='item')=1 THEN (SELECT coalesce(sum(${liveBytes("i")}),0) FROM memory_items i WHERE i.space=NEW.space AND i.memory_id=NEW.memory_id) ELSE 0 END`, 1)}
    END`);
  yield* sql.unsafe(`CREATE TRIGGER memory_import_receipts_import_live_delete AFTER DELETE ON memory_import_receipts
    WHEN OLD.record_kind='item' AND NOT EXISTS(SELECT 1 FROM memory_import_receipts r WHERE r.space=OLD.space AND r.memory_id=OLD.memory_id AND r.record_kind='item')
    BEGIN ${mappedDelta("OLD", -1)} END`);
});
