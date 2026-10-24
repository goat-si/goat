import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import migration from "./085_MemoryRevertResults.ts";
import * as Store from "../../memory/MemoryStore.ts";
import {
  assertUsageCounters,
  scanRevertResultBytes,
} from "../../memory/MemoryUsageScan.testkit.ts";
import * as Layer from "effect/Layer";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(M.MemoryHubReceipt));
const encodeCompact = Schema.encodeEffect(Schema.fromJsonString(M.MemoryCompactReceipt));
const live = Store.layer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })));
it.effect(
  "079 backfills only correlated evidence, rolls back DDL/results, and preserves 078 accounting",
  () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 84 });
      const sql = yield* SqlClient.SqlClient;
      for (let n = 10; n < 15; n++)
        yield* sql`INSERT INTO memory_resolutions(space,resolution_id,memory_id,input_revision_ids_json,input_payload_refs_json,judgment_payload_ref,requested_model_selection_json,effective_provider_model_json,resolving_environment_id,fencing_token,result_revision_id,applied_at,revert_deadline,resolution_json) VALUES (${space},${id(n)},${id(2)},'[]','[]','judgment','{}','{}','fixture',1,${id(n + 100)},0,0,'{}')`;
      yield* sql`INSERT INTO memory_revert_intents(space,operation_id,memory_id,resolution_id,restored_revision_id,expected_heads_json,request_digest,submission_metadata_json,payload_ref,created_at) VALUES (${space},${id(20)},${id(2)},${id(10)},${id(100)},'[]','digest','{}','payload',0)`;
      const refusal: M.MemoryHubReceipt = {
        operationId: M.MemoryOperationId.make(id(21)),
        memoryId: M.MemoryId.make(id(2)),
        operationDigest: "a".repeat(64),
        outcome: "rejected",
        hubSequence: 1,
        failureCode: "revert_expired",
      };
      yield* sql`INSERT INTO memory_outbox(id,space,memory_id,kind,status,metadata_json,next_attempt_at,completed_receipt_json) VALUES ('revert-refusal',${space},${id(2)},'revert_intent','failed',${`{"operationId":"${id(21)}","revertsResolutionId":"${id(11)}"}`},0,${yield* encodeReceipt(refusal)})`;
      const accepted: M.MemoryCompactReceipt = {
        memorySpaceId: space,
        originEnvironmentId: M.EnvironmentId.make("fixture"),
        operationKind: "revert",
        receipt: {
          operationId: M.MemoryOperationId.make(id(22)),
          memoryId: M.MemoryId.make(id(2)),
          operationDigest: "b".repeat(64),
          outcome: "accepted",
          hubSequence: 2,
        },
        revisionId: M.MemoryRevisionId.make(id(122)),
        resolutionId: M.MemoryResolutionId.make(id(12)),
        revertsResolutionId: M.MemoryResolutionId.make(id(12)),
        attemptId: null,
        fencingToken: null,
        reportGuard: {
          reportId: "c".repeat(64),
          resolvingEnvironmentId: M.EnvironmentId.make("fixture"),
          resolutionId: M.MemoryResolutionId.make(id(12)),
          outcome: "reverted",
        },
      };
      yield* sql`INSERT INTO memory_compact_receipts(space,operation_id,operation_digest,hub_sequence,receipt_json,compact_json) VALUES (${space},${id(22)},${"b".repeat(64)},2,${yield* encodeReceipt(accepted.receipt)},${yield* encodeCompact(accepted)})`;
      // An unrelated metadata receipt has no resolution correlation: do not invent it.
      yield* sql`INSERT INTO memory_import_keys(space,key_kind,key,memory_id,record_json) VALUES (${space},'hubReceipt',${id(24)},${id(2)},'{}')`;
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
      assert.isFalse(
        (yield* sql<{ name: string }>`PRAGMA table_info(memory_resolutions)`).some(
          (r) => r.name === "revert_result_json",
        ),
      );
      assert.isEmpty(
        yield* sql`SELECT name FROM sqlite_master WHERE name='memory_report_memory_idx'`,
      );
      assert.deepStrictEqual(yield* runMigrations(), [
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
        [103, "RemoteReportFences"],
      ]);
      assert.deepStrictEqual(
        yield* sql`SELECT resolution_id,revert_operation_id,json_extract(revert_result_json,'$.status') AS status FROM memory_resolutions ORDER BY resolution_id`,
        [
          { resolution_id: id(10), revert_operation_id: id(20), status: "pending" },
          { resolution_id: id(11), revert_operation_id: id(21), status: "revert_expired" },
          { resolution_id: id(12), revert_operation_id: id(22), status: "accepted" },
          { resolution_id: id(13), revert_operation_id: null, status: null },
          { resolution_id: id(14), revert_operation_id: null, status: null },
        ],
      );
      const after = yield* sql<{
        space: string;
        dimension: string;
        scope_key: string;
        value: number;
      }>`SELECT * FROM memory_quota_counters ORDER BY space,dimension,scope_key`;
      assert.deepStrictEqual(
        after.filter((r) => r.dimension !== "memory_input_bytes"),
        before.filter((r) => r.dimension !== "memory_input_bytes"),
      );
      const slotBytes = yield* scanRevertResultBytes;
      for (const row of slotBytes)
        assert.strictEqual(
          after.find((r) => r.space === row.space && r.dimension === "memory_input_bytes")!.value -
            (Number(
              before.find((r) => r.space === row.space && r.dimension === "memory_input_bytes")
                ?.value,
            ) || 0),
          row.bytes,
        );

      yield* assertUsageCounters;
      assert.deepStrictEqual(yield* runMigrations(), []);
      const tooBig =
        yield* sql`UPDATE memory_resolutions SET revert_result_json=${`{"status":"${"한".repeat(700)}"}`} WHERE resolution_id=${id(10)}`.pipe(
          Effect.exit,
        );
      assert.isTrue(Exit.isFailure(tooBig));
      assert.lengthOf(yield* sql`SELECT 1 FROM memory_resolutions`, 5);
    }).pipe(Effect.provide(live)),
);
