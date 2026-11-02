import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import { refreshCheckpointAccounting } from "../../memory/MemoryCheckpointAccounting.ts";
import { checkpointBound } from "../../memory/MemoryCheckpointBound.ts";
import { decideMemoryOperation, memoryOperationDigest } from "../../memory/MemoryDecider.ts";
import { scanMemoryValue } from "../../memory/MemorySecretScanner.ts";
import * as Store from "../../memory/MemoryStore.ts";
import memory from "./078_Memory.ts";
import hub from "./079_MemoryHubSync.ts";
import search from "./080_MemorySearchCounters.ts";
import lineage from "./082_MemoryImportLineage.ts";
import checkpoint from "./083_MemoryCheckpointAccounting.ts";
import report from "./084_MemoryReportLifecycle.ts";
import usage from "./085_MemoryUsageCounters.ts";
import revert from "./086_MemoryRevertResults.ts";
import ready from "./088_MemoryLastReadySpace.ts";
import admin from "./089_MemoryHubAdministered.ts";
import lifecycle from "./090_MemoryCheckpointLifecycle.ts";
import revisionSize from "./095_MemoryRevisionCheckpointSize.ts";
import migration from "./123_MemoryCheckpointBound.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const env = M.EnvironmentId.make("fixture");
const thread = { environmentId: env, threadId: M.ThreadId.make("thread-fixture") };
const watermark = {
  fromEventId: M.EventId.make("event-from"),
  toEventId: M.EventId.make("event-to"),
  throughSequence: 9,
};
const layer = Store.layer.pipe(
  Layer.provideMerge(
    Layer.effectDiscard(
      Effect.all([
        memory,
        hub,
        lineage,
        checkpoint,
        revisionSize,
        report,
        usage,
        revert,
        ready,
        admin,
        lifecycle,
        search,
      ]),
    ).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" }))),
  ),
);
const decodeOperation = Schema.decodeUnknownSync(M.MemoryOperation);
const upsert = (n: number) =>
  decodeOperation({
    protocolVersion: 1,
    memorySpaceId: space,
    memoryId: id(100 + n),
    operationId: id(200 + n),
    originEnvironmentId: env,
    expectedHeads: [],
    kind: "upsert",
    revision: {
      memorySpaceId: space,
      memoryId: id(100 + n),
      revisionId: id(300 + n),
      operationId: id(200 + n),
      parents: [],
      scope: { kind: "thread", thread },
      payloadRef: id(300 + n),
      assertionKind: "inference",
      provenance: { environmentId: env, sourceThread: thread, sourceWatermark: watermark },
      createdAtUtc: "2026-10-14T00:00:00.000Z",
    },
    payload: {
      text: `summary ${n}`,
      evidence: [{ origin: "thread", sourceThread: thread, watermark, messageIds: [`m-${n}`] }],
      derivedFromMemoryRevisions: [],
    },
  });
const refusal = (dimension: string) =>
  JSON.stringify({
    operationId: id(900),
    memoryId: id(100),
    operationDigest: "f".repeat(64),
    outcome: "rejected",
    hubSequence: null,
    failureCode: "capacity_exceeded",
    capacity: {
      code: "capacity_exceeded",
      dimension,
      current: 735170789,
      limit: 134217728,
      reclaimable: 0,
    },
  });

it.effect(
  "re-measures legacy forget reserves, refreshes checkpoint counters and re-arms only staging-refused syncs",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* Store.MemoryStore;
      for (const n of [0, 1, 2]) {
        const op = upsert(n);
        yield* store.transact(
          Effect.gen(function* () {
            const ledger = yield* store.appendHubEntryTx({
              operation: op,
              operationDigest: memoryOperationDigest(op),
              outcome: "accepted",
              now: 0,
            });
            const decided = decideMemoryOperation(
              yield* store.loadAggregate(space, op.memoryId),
              op,
              Store.hubAdmission,
              scanMemoryValue(op),
            );
            yield* store.apply({ ...decided, receipt: ledger.entry.receipt });
          }),
        );
      }
      const measured = yield* sql<{
        memory_id: string;
        reserve_bytes: number;
        reserve_keys: number;
      }>`SELECT memory_id,reserve_bytes,reserve_keys FROM memory_identity_ledger ORDER BY memory_id`;
      const counters = sql<{
        dimension: string;
        value: number;
      }>`SELECT dimension,value FROM memory_quota_counters WHERE space=${space} AND scope_key='' AND dimension IN ('hub_snapshot_bytes','hub_snapshot_rows') ORDER BY dimension`;
      const fresh = yield* counters;
      // The pre-fix store reserved at least a full payload for every identity.
      yield* sql`UPDATE memory_identity_ledger SET reserve_bytes=${M.MEMORY_IDENTITY_CORE_MAX_BYTES + M.MEMORY_PAYLOAD_MAX_UTF8_BYTES}`;
      yield* refreshCheckpointAccounting();
      const legacy = yield* counters;
      const metadata = (n: number, kind = "upsert") =>
        JSON.stringify({
          kind,
          operationId: id(200 + n),
          memoryId: id(100 + n),
          revision: { payloadRef: id(300 + n) },
        });
      for (const [row, n, dimension, kind] of [
        ["staging", 0, "checkpoint_staging", "upsert"],
        ["purged", 7, "checkpoint_staging", "upsert"],
        ["receipts", 1, "receipts", "upsert"],
        ["forget", 2, "checkpoint_staging", "forget"],
      ] as const)
        yield* sql`INSERT INTO memory_outbox(id,space,memory_id,kind,status,metadata_json,payload_ref,attempt,next_attempt_at,completed_receipt_json,terminal_at) VALUES (${row},${space},${id(100 + n)},'sync','failed',${metadata(n, kind)},NULL,3,0,${refusal(dimension)},5)`;
      yield* sql.withTransaction(migration);
      assert.deepStrictEqual(
        yield* sql`SELECT memory_id,reserve_bytes,reserve_keys FROM memory_identity_ledger ORDER BY memory_id`,
        measured,
      );
      const after = yield* counters;
      // Re-arming flips one item's pendingSync, so compare against a full re-measurement.
      yield* sql`INSERT INTO memory_quota_counters(space,dimension,scope_key,value) SELECT '_checkpoint_dirty',space,'m:'||memory_id,1 FROM memory_identity_ledger`;
      yield* refreshCheckpointAccounting("recompute");
      assert.deepStrictEqual(after, yield* counters);
      assert.strictEqual(after[1]!.value, fresh[1]!.value);
      const bound = (rows: ReadonlyArray<{ dimension: string; value: number }>) =>
        checkpointBound(rows[0]!.value, rows[1]!.value);
      assert.isBelow(bound(after), bound(legacy));
      assert.deepStrictEqual(
        yield* sql`SELECT id,status,payload_ref,attempt,completed_receipt_json IS NULL AS cleared FROM memory_outbox ORDER BY id`,
        [
          { id: "forget", status: "failed", payload_ref: null, attempt: 3, cleared: 0 },
          { id: "purged", status: "failed", payload_ref: null, attempt: 3, cleared: 0 },
          { id: "receipts", status: "failed", payload_ref: null, attempt: 3, cleared: 0 },
          { id: "staging", status: "pending", payload_ref: id(300), attempt: 0, cleared: 1 },
        ],
      );
    }).pipe(Effect.provide(layer)),
);
