import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as M from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
import migration, {
  memoryUsageHeadBytes,
  memoryUsageSummary,
  memoryUsagePayloadLive,
  memoryUsageRevisionItemMatch,
} from "./084_MemoryUsageCounters.ts";
import * as Store from "../../memory/MemoryStore.ts";
import { assertUsageCounters } from "../../memory/MemoryUsageScan.testkit.ts";

const database = Layer.effectDiscard(runMigrations({ toMigrationInclusive: 83 })).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const live = Store.layer.pipe(Layer.provideMerge(database));
it.effect(
  "078 backfills populated spaces once, rolls DDL/accounting back, and survives restart",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const space of [
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      ]) {
        yield* sql`INSERT INTO memory_items(space,memory_id,scope_json,scope_key,heads_json,status,projection_watermark,item_json,availability_json) VALUES (${space},'memory','{"kind":"user"}','user','["revision"]','active',0,'{}','{}')`;
        yield* sql`INSERT INTO memory_revisions(space,revision_id,memory_id,operation_id,parents_json,scope_json,assertion_kind,provenance_json,payload_ref,created_at) VALUES (${space},'revision','memory','op','[]','{"kind":"user"}','inference','{"sourceThread":"synthetic"}','payload',0)`;
        yield* sql`INSERT INTO memory_payloads(space,payload_ref,memory_id,body_json,dependencies_json) VALUES (${space},'payload','memory','{"text":"한글"}','[]'),(${space},'history','memory','{"text":"old"}','[]')`;
        yield* sql`INSERT INTO memory_identity_ledger(space,memory_id,identity_json,fence_json,reserve_bytes,reserve_keys) VALUES (${space},'memory','{}','{}',100,2)`;
        yield* sql`INSERT INTO memory_events(protocol_version,memory_space_id,memory_id,operation_id,kind,origin_environment_id,operation_digest,metadata_json,receipt_json,created_at) VALUES (1,${space},'memory','op','upsert','synthetic','digest','{}','{}',0)`;
        yield* sql`INSERT INTO memory_compact_receipts(space,operation_id,operation_digest,hub_sequence,receipt_json,compact_json) VALUES (${space},'op','digest',1,'{}','{}')`;
        yield* sql`INSERT INTO memory_import_lineage(space,memory_id,kind,key,record_json) VALUES (${space},'memory','content','key','{}')`;
        yield* sql`INSERT INTO memory_import_keys(space,key_kind,key,memory_id,record_json) VALUES (${space},'content','key','memory','{}')`;
      }
      const before =
        yield* sql`SELECT * FROM memory_quota_counters ORDER BY space,dimension,scope_key`;
      const rollback = yield* sql
        .withTransaction(migration.pipe(Effect.andThen(Effect.fail("rollback"))))
        .pipe(Effect.exit);
      assert.deepStrictEqual(rollback, Exit.fail("rollback"));
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM memory_quota_counters ORDER BY space,dimension,scope_key`,
        before,
      );
      assert.deepStrictEqual(yield* runMigrations(), [
        [84, "MemoryUsageCounters"],
        [85, "MemoryRevertResults"],
        [86, "HandoffLookupIndex"],
        [87, "MemoryLastReadySpace"],
        [88, "MemoryHubAdministered"],
        [89, "MemoryCheckpointLifecycle"],
        [90, "FleetGoals"],
        [91, "FleetHealth"],
        [92, "ThreadRunObservedChecks"],
        [93, "RemoteDispatchObservation"],
        [94, "MemoryRevisionCheckpointSize"],
        [95, "HubNodes"],
        [96, "MemorySummaryWorkThreadIndex"],
        [97, "ThreadHistoryArchives"],
        [98, "PermissionProfiles"],
        [99, "DecisionInbox"],
        [100, "HumanStepRecords"],
        [101, "McpRequestReservations"],
        [102, "RemoteReportInboxRunId"],
        [103, "RemoteReportReceipts"],
        [104, "PendingAttachmentUploads"],
        [105, "ScheduledTaskWebhookSecretRef"],
        [106, "RemoteReportFences"],
        [107, "HubProvisionedLinks"],
      ]);
      yield* assertUsageCounters;
      assert.deepStrictEqual(yield* runMigrations(), []);
      yield* assertUsageCounters;
      yield* sql`DELETE FROM memory_compact_receipts`;
      yield* assertUsageCounters;
      yield* sql`DELETE FROM memory_events`;
      yield* assertUsageCounters;
      yield* sql`DELETE FROM memory_payloads`;
      yield* assertUsageCounters;
    }).pipe(Effect.provide(live)),
);

it.effect("actual trigger expressions and runtime usage queries use complete lookup keys", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    const store = yield* Store.MemoryStore;
    const explain = (query: string, params: ReadonlyArray<unknown> = []) =>
      sql
        .unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, params)
        .pipe(Effect.map((rows) => rows.map((r) => r.detail).join("\n")));
    const itemLookup = /SEARCH i .*\(space=\? AND memory_id=\?\)/;
    const revisionLookup = /SEARCH r .*\(space=\? AND revision_id=\?\)/;
    const payloadLookup = /SEARCH p .*\(space=\? AND payload_ref=\?\)/;
    const root = "FROM memory_items i WHERE i.space='fixture' AND i.memory_id='memory'";
    for (const [name, expression, lookups] of [
      ["head bytes", memoryUsageHeadBytes("i"), [itemLookup, revisionLookup, payloadLookup]],
      ["summary", memoryUsageSummary("i"), [itemLookup, revisionLookup]],
      ["payload live", memoryUsagePayloadLive("p"), [itemLookup, revisionLookup, payloadLookup]],
    ] as const) {
      const from =
        name === "payload live"
          ? "FROM memory_payloads p WHERE p.space='fixture' AND p.payload_ref='payload'"
          : root;
      const details = yield* explain(`SELECT ${expression} ${from}`);
      for (const lookup of lookups) assert.match(details, lookup, `${name}: ${details}`);
      assert.isFalse(/SCAN [irp]\b/.test(details), `${name}: ${details}`);
    }
    // Exercise the same OLD/NEW predicates used by revision INSERT/UPDATE/DELETE triggers.
    for (const [prefix, distinctNew] of [
      ["OLD", false],
      ["NEW", false],
      ["NEW", true],
    ] as const) {
      const match = memoryUsageRevisionItemMatch(prefix, distinctNew);
      for (const expression of [
        memoryUsageHeadBytes("i"),
        memoryUsageSummary("i"),
        "i.scope_key",
      ]) {
        const details = yield* explain(
          `SELECT (SELECT ${expression} FROM memory_items i WHERE ${match}) FROM (SELECT 'fixture' space,'memory' memory_id) OLD CROSS JOIN (SELECT 'fixture' space,'other' memory_id) NEW`,
        );
        assert.match(details, itemLookup, details);
        if (expression !== "i.scope_key") assert.match(details, revisionLookup, details);
        if (expression === memoryUsageHeadBytes("i")) assert.match(details, payloadLookup, details);
        assert.isFalse(/SCAN [irp]\b/.test(details), details);
      }
    }
    yield* sql`INSERT INTO memory_quota_counters(space,dimension,scope_key,value) SELECT 'fixture','usage_items','explicit:' || value,0 FROM json_each(${JSON.stringify(Array.from({ length: 1000 }, (_, n) => n))})`;
    const queries: Array<readonly [string, ReadonlyArray<unknown>]> = [];
    const record: Statement.Transformer = (statement) =>
      Effect.sync(() => {
        queries.push(statement.compile());
        return statement;
      });
    yield* store
      .usage(M.MemorySpaceId.make("00000000-0000-4000-8000-000000000001"), { kind: "user" })
      .pipe(Effect.provideService(Statement.CurrentTransformer, record));
    assert.lengthOf(queries, 2);
    for (const [query, params] of queries) {
      const details = yield* explain(query, params);
      assert.match(
        details,
        /SEARCH memory_quota_counters .*\(space=\? AND dimension=\? AND scope_key=\?\)/,
        details,
      );
      assert.isFalse(/SCAN memory_quota_counters/.test(details), details);
    }
  }).pipe(Effect.provide(live)),
);
