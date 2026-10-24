import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as SqlClient from "effect/sql/SqlClient";
import memory from "./077_Memory.ts";
import hub from "./078_MemoryHubSync.ts";

it.effect("upgrades 071 without rewriting legacy resolution data or sync payloads", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* memory;
    yield* sql`INSERT INTO memory_events (protocol_version,memory_space_id,memory_id,operation_id,kind,origin_environment_id,operation_digest,metadata_json,receipt_json,created_at) VALUES (1,'space','memory','operation','forget','env','original-digest','{}','{}',0)`;
    yield* sql`INSERT INTO memory_outbox (id,space,kind,status,metadata_json,next_attempt_at) VALUES ('sync','space','sync','retry','{"operationId":"operation"}',42)`;
    // Pre-upgrade canonical metadata is seeded into global counters once.
    yield* sql`INSERT INTO memory_identity_ledger(space,memory_id,identity_json,fence_json,reserve_bytes,reserve_keys) VALUES ('space','memory','{}','{}',101,2)`;
    yield* sql`INSERT INTO memory_import_keys(space,key_kind,key,memory_id,record_json) VALUES ('space','fixture','key','memory','"한글"')`;
    yield* hub;
    const counter = (dimension: string) =>
      sql<{
        value: number;
      }>`SELECT value FROM memory_quota_counters WHERE space='_hub_global' AND dimension=${dimension} AND scope_key=''`.pipe(
        Effect.map((rows) => rows[0]!.value),
      );
    assert.strictEqual(
      yield* counter("hub_metadata"),
      101 + 336 + 336 + new TextEncoder().encode('"한글"').length,
    );
    assert.strictEqual(yield* counter("hub_receipts"), 2);
    assert.strictEqual(yield* counter("hub_ids"), 1);
    assert.strictEqual(yield* counter("hub_keys"), 3);
    const baseline = yield* counter("hub_metadata");
    yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status) VALUES ('other','환경','digest',1,'active')`;
    const privateBytes = new TextEncoder().encode("other환경digest1active").length;
    assert.strictEqual(yield* counter("hub_private_metadata"), privateBytes);
    assert.strictEqual(yield* counter("hub_metadata"), baseline + privateBytes);
    yield* sql`UPDATE memory_hub_members SET credential_digest='changed-digest' WHERE space='other'`;
    assert.strictEqual(yield* counter("hub_metadata"), baseline + privateBytes + 8);
    yield* sql`DELETE FROM memory_hub_members WHERE space='other'`;
    assert.strictEqual(yield* counter("hub_metadata"), baseline);
    // Event -> compact representation -> event retirement counts one receipt throughout.
    yield* sql`INSERT INTO memory_compact_receipts(space,operation_id,operation_digest,hub_sequence,receipt_json,compact_json,compact_blob) VALUES ('space','operation','original-digest',1,'{}','{}',${new Uint8Array([1, 2, 3, 4])})`;
    assert.strictEqual(yield* counter("hub_receipts"), 2);
    assert.strictEqual(yield* counter("hub_metadata"), baseline - 336 + 4);
    yield* sql`DELETE FROM memory_events WHERE operation_id='operation'`;
    assert.strictEqual(yield* counter("hub_receipts"), 2);
    assert.strictEqual(yield* counter("hub_metadata"), baseline - 336 + 4);
    yield* sql`INSERT INTO memory_events (protocol_version,memory_space_id,memory_id,operation_id,kind,origin_environment_id,operation_digest,metadata_json,receipt_json,created_at) VALUES (1,'space','memory','operation','forget','env','original-digest','{}','{}',0)`;
    const failed = yield* sql
      .withTransaction(
        sql`UPDATE memory_identity_ledger SET reserve_bytes=202 WHERE memory_id='memory'`.pipe(
          Effect.andThen(Effect.fail("rollback")),
        ),
      )
      .pipe(Effect.flip);
    assert.strictEqual(failed, "rollback");
    assert.strictEqual(yield* counter("hub_metadata"), baseline - 336 + 4);
    const rows = yield* sql<{
      operation_digest: string;
      sync_version: number;
      next_attempt_at: number;
    }>`SELECT operation_digest,sync_version,next_attempt_at FROM memory_outbox`;
    assert.deepStrictEqual(rows, [
      { operation_digest: "original-digest", sync_version: 0, next_attempt_at: 42 },
    ]);
    const tables =
      yield* sql`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'memory_hub_%'`;
    assert.strictEqual(tables.length, 5);
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(memory_outbox)`;
    assert.isTrue(columns.some((c) => c.name === "frozen_claim_json"));
    assert.isTrue(columns.some((c) => c.name === "terminal_at"));
    const triggers =
      yield* sql`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%hub_account_%'`;
    assert.strictEqual(triggers.length, 33);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "seeds and maintains snapshot byte and row counters across UTF-8 updates, retirement and rollback",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* memory;
      yield* sql`INSERT INTO memory_payloads(space,payload_ref,memory_id,body_json,dependencies_json) VALUES ('space','payload','memory','한글','[]')`;
      yield* hub;
      const counters = () =>
        sql<{
          dimension: string;
          value: number;
        }>`SELECT dimension,value FROM memory_quota_counters WHERE space='space' AND dimension IN ('hub_snapshot_bytes','hub_snapshot_rows') ORDER BY dimension`;
      assert.deepStrictEqual(yield* counters(), [
        { dimension: "hub_snapshot_bytes", value: 6 },
        { dimension: "hub_snapshot_rows", value: 1 },
      ]);
      const generation = () =>
        sql<{
          value: number;
        }>`SELECT value FROM memory_quota_counters WHERE space='space' AND dimension='hub_snapshot_generation'`;
      yield* sql`UPDATE memory_payloads SET body_json=body_json WHERE space='space'`;
      assert.deepStrictEqual(yield* counters(), [
        { dimension: "hub_snapshot_bytes", value: 6 },
        { dimension: "hub_snapshot_rows", value: 1 },
      ]);
      assert.deepStrictEqual(yield* generation(), []);
      yield* sql`UPDATE memory_payloads SET body_json='한글abc' WHERE space='space'`;
      assert.deepStrictEqual(yield* generation(), [{ value: 1 }]);
      yield* sql`UPDATE memory_payloads SET dependencies_json='["local-only"]' WHERE space='space'`;
      assert.deepStrictEqual(yield* generation(), [{ value: 1 }]);
      assert.strictEqual((yield* counters())[0]!.value, 9);
      yield* sql
        .withTransaction(
          sql`DELETE FROM memory_payloads WHERE space='space'`.pipe(
            Effect.andThen(Effect.fail("rollback")),
          ),
        )
        .pipe(Effect.flip);
      assert.deepStrictEqual(yield* counters(), [
        { dimension: "hub_snapshot_bytes", value: 9 },
        { dimension: "hub_snapshot_rows", value: 1 },
      ]);
      yield* sql`DELETE FROM memory_payloads WHERE space='space'`;
      assert.deepStrictEqual(yield* counters(), [
        { dimension: "hub_snapshot_bytes", value: 0 },
        { dimension: "hub_snapshot_rows", value: 0 },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("processing counter upgrade and refusal compaction count canonical receipts once", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* memory;
    yield* sql`INSERT INTO memory_events(protocol_version,memory_space_id,memory_id,operation_id,kind,origin_environment_id,operation_digest,metadata_json,receipt_json,created_at) VALUES (1,'space','memory','refusal','forget','env','digest','{}','{"outcome":"rejected"}',0)`;
    yield* sql`INSERT INTO memory_compact_receipts(space,operation_id,operation_digest,hub_sequence,receipt_json,compact_json) VALUES ('space','refusal','digest',1,'{"outcome":"rejected"}','{}')`;
    yield* hub;
    const count = () =>
      sql<{
        value: number;
      }>`SELECT value FROM memory_quota_counters WHERE space='space' AND dimension='processing_admission_failures' AND scope_key=''`.pipe(
        Effect.map((rows) => rows[0]!.value),
      );
    assert.strictEqual(yield* count(), 1);
    yield* sql`DELETE FROM memory_events WHERE operation_id='refusal'`;
    assert.strictEqual(yield* count(), 1);
    yield* sql`DELETE FROM memory_compact_receipts WHERE operation_id='refusal'`;
    assert.strictEqual(yield* count(), 0);
    yield* sql`INSERT INTO memory_events(protocol_version,memory_space_id,memory_id,operation_id,kind,origin_environment_id,operation_digest,metadata_json,receipt_json,created_at) VALUES (1,'space','memory','refusal','forget','env','digest','{}','{"outcome":"rejected"}',0)`;
    assert.strictEqual(yield* count(), 1);
    yield* sql`INSERT INTO memory_compact_receipts(space,operation_id,operation_digest,hub_sequence,receipt_json,compact_json) VALUES ('space','refusal','digest',1,'{"outcome":"rejected"}','{}')`;
    assert.strictEqual(yield* count(), 1);
    yield* sql`DELETE FROM memory_events WHERE operation_id='refusal'`;
    assert.strictEqual(yield* count(), 1);
    yield* sql
      .withTransaction(
        sql`DELETE FROM memory_compact_receipts WHERE operation_id='refusal'`.pipe(
          Effect.andThen(Effect.fail("rollback")),
        ),
      )
      .pipe(Effect.flip);
    assert.strictEqual(yield* count(), 1);
    const plan = yield* sql<{
      detail: string;
    }>`EXPLAIN QUERY PLAN SELECT dimension,value FROM memory_quota_counters WHERE space='space' AND scope_key='' AND dimension IN ('processing_admission_failures','processing_pending_sync')`;
    assert.isFalse(plan.some((r) => r.detail.includes("SCAN")));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "item processing seed and deltas match source rows without unchanged counter writes",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* memory;
      yield* sql`INSERT INTO memory_items(space,memory_id,scope_json,scope_key,heads_json,status,projection_watermark,item_json,availability_json,index_state,indexed_generation,generation,cleanup_pending,deferred_json) VALUES ('space','a','{}','user','[]','active',0,'{}','{"reasons":[]}','ready',1,1,0,'[]'),('space','b','{}','user','[]','quarantined',0,'{}','{"reasons":["secret_detected","scanner_pending","missing_parent"]}','held',NULL,0,1,'[{"state":"held"},{"state":"pending"},{"state":"ready"}]')`;
      yield* hub;
      const verify = Effect.gen(function* () {
        const source = yield* sql<{
          space: string;
          quarantined: number;
          eligible: number;
          indexed: number;
          cleanup: number;
          scanner_held: number;
          scanner_pending: number;
          missing_parent: number;
          deferred: number;
        }>`SELECT space,
        sum(status='quarantined') AS quarantined,sum(status='active') AS eligible,
        sum(coalesce(status='active' AND index_state='ready' AND indexed_generation=generation,0)) AS indexed,
        sum(cleanup_pending) AS cleanup,
        sum(EXISTS(SELECT 1 FROM json_each(availability_json,'$.reasons') WHERE value='secret_detected')) AS scanner_held,
        sum(EXISTS(SELECT 1 FROM json_each(availability_json,'$.reasons') WHERE value='scanner_pending')) AS scanner_pending,
        sum(EXISTS(SELECT 1 FROM json_each(availability_json,'$.reasons') WHERE value='missing_parent')) AS missing_parent,
        sum((SELECT count(*) FROM json_each(deferred_json) WHERE json_extract(value,'$.state')!='ready')) AS deferred
        FROM memory_items GROUP BY space`;
        for (const row of source) {
          for (const dimension of [
            "quarantined",
            "eligible",
            "indexed",
            "cleanup",
            "scanner_held",
            "scanner_pending",
            "missing_parent",
            "deferred",
          ] as const) {
            const counters = yield* sql<{
              value: number;
            }>`SELECT value FROM memory_quota_counters WHERE space=${row.space} AND dimension=${`processing_${dimension}`} AND scope_key=''`;
            assert.strictEqual(counters[0]?.value ?? 0, row[dimension]);
          }
        }
      });
      yield* verify;
      yield* sql`CREATE TABLE counter_writes(dimension TEXT)`;
      yield* sql`CREATE TRIGGER audit_counter_update AFTER UPDATE ON memory_quota_counters WHEN NEW.dimension LIKE 'processing_%' BEGIN INSERT INTO counter_writes VALUES (NEW.dimension); END`;
      yield* sql`CREATE TRIGGER audit_counter_insert AFTER INSERT ON memory_quota_counters WHEN NEW.dimension LIKE 'processing_%' BEGIN INSERT INTO counter_writes VALUES (NEW.dimension); END`;
      yield* sql`UPDATE memory_items SET status=status,index_state=index_state,indexed_generation=indexed_generation,generation=generation,cleanup_pending=cleanup_pending,deferred_json=deferred_json,availability_json=availability_json WHERE memory_id='a'`;
      assert.strictEqual((yield* sql`SELECT 1 FROM counter_writes`).length, 0);
      yield* sql`UPDATE memory_items SET cleanup_pending=1 WHERE memory_id='a'`;
      assert.deepStrictEqual(yield* sql`SELECT dimension FROM counter_writes`, [
        { dimension: "processing_cleanup" },
      ]);
      yield* verify;
      yield* sql`UPDATE memory_items SET status='blocked',generation=2,availability_json='{"reasons":["scanner_pending"]}',deferred_json='[{"state":"pending"}]' WHERE memory_id='a'`;
      yield* verify;
      yield* sql`UPDATE memory_items SET space='other' WHERE memory_id='b'`;
      yield* verify;
      const before =
        yield* sql`SELECT space,dimension,value FROM memory_quota_counters WHERE dimension LIKE 'processing_%' ORDER BY space,dimension`;
      yield* sql
        .withTransaction(
          sql`UPDATE memory_items SET status='active',index_state='ready',indexed_generation=generation,cleanup_pending=0,deferred_json='[]',availability_json='{"reasons":[]}' WHERE memory_id='b'`.pipe(
            Effect.andThen(Effect.fail("rollback")),
          ),
        )
        .pipe(Effect.flip);
      assert.deepStrictEqual(
        yield* sql`SELECT space,dimension,value FROM memory_quota_counters WHERE dimension LIKE 'processing_%' ORDER BY space,dimension`,
        before,
      );
      yield* verify;
      yield* sql`DELETE FROM memory_items WHERE memory_id='b'`;
      assert.isTrue(
        (yield* sql<{
          value: number;
        }>`SELECT value FROM memory_quota_counters WHERE space='other' AND dimension LIKE 'processing_%'`).every(
          (r) => r.value === 0,
        ),
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("keeps retry accounting separate from canonical snapshot dependencies", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* memory;
    const inventory = () => sql`SELECT
      (SELECT count(*) FROM sqlite_master WHERE type='trigger') AS triggers,
      (SELECT count(*) FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%') AS explicit_indexes,
      (SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%') AS tables,
      (SELECT sum((SELECT count(*) FROM pragma_table_xinfo(m.name))) FROM sqlite_master m WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%') AS columns`;
    const before = yield* inventory();
    yield* hub;
    const after = yield* inventory();
    yield* Effect.log("R13_SCHEMA_INVENTORY", { before, after }).pipe(
      Effect.provide(Logger.layer([Logger.consolePretty({ colors: false })])),
    );
    const triggers = yield* sql<{
      name: string;
    }>`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='memory_sync_cursors' ORDER BY name`;
    assert.deepStrictEqual(
      triggers.map((r) => r.name),
      [
        "memory_sync_cursors_hub_snapshot_bytes_delete",
        "memory_sync_cursors_hub_snapshot_bytes_insert",
        "memory_sync_cursors_hub_snapshot_bytes_update",
      ],
    );
    yield* sql`INSERT INTO memory_sync_cursors(space,hub_environment_id,after_sequence,bootstrap_state) VALUES ('space','hub',0,'ready')`;
    yield* sql`INSERT INTO memory_hub_retention(space,handles_json,reserved_snapshot_id,snapshot_generation,published_pinned_bytes) VALUES ('space','[]','stage',7,2)`;
    yield* sql`INSERT INTO memory_inbox_pending(space,pending_key,record_kind,metadata_json,reason,checkpoint_id,missing_parents_json) VALUES ('space','page','checkpoint','{}','hub_snapshot','hub:stage','[]')`;
    const generation =
      yield* sql`SELECT value FROM memory_quota_counters WHERE space='space' AND dimension='hub_snapshot_generation'`;
    yield* sql`UPDATE memory_sync_cursors SET pull_retry_json='{}' WHERE space='space'`;
    yield* sql`UPDATE memory_sync_cursors SET pull_retry_json='[]' WHERE space='space'`;
    assert.deepStrictEqual(
      yield* sql`SELECT reserved_snapshot_id,snapshot_generation FROM memory_hub_retention WHERE space='space'`,
      [{ reserved_snapshot_id: "stage", snapshot_generation: 7 }],
    );
    assert.deepStrictEqual(
      yield* sql`SELECT value FROM memory_quota_counters WHERE space='space' AND dimension='hub_snapshot_generation'`,
      generation,
    );
    assert.strictEqual(
      (yield* sql`SELECT 1 FROM memory_inbox_pending WHERE checkpoint_id='hub:stage'`).length,
      1,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("r14 indexes only active same-memory resolutions and keeps receipt lookup keyed", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* memory;
    yield* hub;
    const definition = (yield* sql<{
      sql: string;
    }>`SELECT sql FROM sqlite_master WHERE type='index' AND name='memory_outbox_active_resolution'`)[0]!
      .sql;
    assert.include(definition, "(space,memory_id)");
    assert.include(definition, "kind='resolve'");
    assert.include(definition, "status IN ('pending','retry','running')");
    const plan = yield* sql<{
      detail: string;
    }>`EXPLAIN QUERY PLAN SELECT operation_digest,receipt_json FROM memory_events WHERE memory_space_id='space' AND operation_id='operation' UNION ALL SELECT operation_digest,receipt_json FROM memory_compact_receipts WHERE space='space' AND operation_id='operation' UNION ALL SELECT json_extract(record_json,'$.receipt.operationDigest'),json_extract(record_json,'$.receipt') FROM memory_import_keys WHERE space='space' AND key_kind='hubReceipt' AND key='operation' LIMIT 3`;
    assert.strictEqual(plan.filter((r) => r.detail.includes("SEARCH")).length, 3);
    assert.isFalse(plan.some((r) => r.detail.includes("SCAN") || r.detail.includes("TEMP B-TREE")));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "r16 seeds only local intents as pending sync and rolls metadata/status deltas back",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* memory;
      const metadata = '{"kind":"localIntent","environmentId":"fixture"}';
      yield* sql`INSERT INTO memory_outbox(id,space,kind,status,metadata_json,next_attempt_at) VALUES ('draft','_local:fixture','admin','pending',${metadata},0),('other-admin','_local:fixture','admin','pending','{}',0),('other-space','other','admin','pending',${metadata},0)`;
      yield* hub;
      const pending = () =>
        sql<{
          value: number;
        }>`SELECT value FROM memory_quota_counters WHERE space='_local:fixture' AND dimension='processing_pending_sync' AND scope_key=''`.pipe(
          Effect.map((rows) => rows[0]!.value),
        );
      assert.strictEqual(yield* pending(), 1);
      yield* sql`UPDATE memory_outbox SET metadata_json='{}' WHERE id='draft'`;
      assert.strictEqual(yield* pending(), 0);
      yield* sql`UPDATE memory_outbox SET metadata_json=${metadata} WHERE id='draft'`;
      assert.strictEqual(yield* pending(), 1);
      yield* sql
        .withTransaction(
          sql`UPDATE memory_outbox SET status='completed' WHERE id='draft'`.pipe(
            Effect.andThen(Effect.fail("rollback")),
          ),
        )
        .pipe(Effect.flip);
      assert.strictEqual(yield* pending(), 1);
      yield* sql`UPDATE memory_outbox SET status='completed' WHERE id='draft'`;
      assert.strictEqual(yield* pending(), 0);
      yield* sql`UPDATE memory_outbox SET status='retry' WHERE id='draft'`;
      assert.strictEqual(yield* pending(), 1);
      yield* sql`DELETE FROM memory_outbox WHERE id='draft'`;
      assert.strictEqual(yield* pending(), 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
