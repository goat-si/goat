import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import { refreshCheckpointAccounting } from "../../memory/MemoryCheckpointAccounting.ts";
import { checkpointBound } from "../../memory/MemoryCheckpointBound.ts";
import { decideMemoryOperation, memoryOperationDigest } from "../../memory/MemoryDecider.ts";
import { scanMemoryValue } from "../../memory/MemorySecretScanner.ts";
import { measureForgetReservation } from "../../memory/store/ForgetReservation.ts";
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

it.effect(
  "batches migration 123 reads while preserving each space's forget reservation (#2412)",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* Store.MemoryStore;
      const otherSpace = M.MemorySpaceId.make(id(2));
      const expected: Array<{
        space: string;
        memory_id: string;
        reserve_bytes: number;
        reserve_keys: number;
      }> = [];
      for (let n = 0; n < 205; n++) {
        const original = upsert(n);
        const targetSpace = n === 204 ? otherSpace : space;
        const base = n === 204 ? upsert(0) : original;
        if (base.kind !== "upsert") throw new Error("Expected an upsert");
        const op = decodeOperation({
          ...base,
          memorySpaceId: targetSpace,
          revision: { ...base.revision, memorySpaceId: targetSpace },
        });
        if (op.kind !== "upsert") throw new Error("Expected an upsert");
        yield* store.transact(
          Effect.gen(function* () {
            const ledger = yield* store.appendHubEntryTx({
              operation: op,
              operationDigest: memoryOperationDigest(op),
              outcome: "accepted",
              now: 0,
            });
            const decided = decideMemoryOperation(
              yield* store.loadAggregate(targetSpace, op.memoryId),
              op,
              Store.hubAdmission,
              scanMemoryValue(op),
            );
            yield* store.apply({ ...decided, receipt: ledger.entry.receipt });
          }),
        );
        const records: M.MemoryImportLineageRecord[] =
          n === 0 || n === 204
            ? [
                {
                  memorySpaceId: targetSpace,
                  memoryId: op.memoryId,
                  kind: "sourceKey",
                  sourceKey: {
                    environmentId: env,
                    sourceId: M.MemoryImportSourceId.make(id(9000 + n)),
                    sourceItemKey: `source-${n}`,
                  },
                },
              ]
            : [];
        for (const record of records)
          yield* sql`INSERT INTO memory_import_lineage(space,memory_id,kind,key,record_json) VALUES (${targetSpace},${op.memoryId},'sourceKey',${`key-${n}`},${JSON.stringify(record)})`;
        const reservation = yield* measureForgetReservation(
          op,
          [{ revision: op.revision, payload: op.payload }],
          records,
        );
        expected.push({
          space: targetSpace,
          memory_id: op.memoryId,
          reserve_bytes: M.MEMORY_IDENTITY_CORE_MAX_BYTES + reservation.bytes,
          reserve_keys: reservation.keys,
        });
      }
      yield* sql`UPDATE memory_identity_ledger SET reserve_bytes=0,reserve_keys=0`;
      const statements: string[] = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (time, exit) => {
            end(time, exit);
            const query = span.attributes.get("db.query.text");
            if (typeof query === "string") statements.push(query);
          };
          return span;
        },
      });
      yield* sql.withTransaction(migration).pipe(Effect.withTracer(tracer));
      assert.deepStrictEqual(
        yield* sql`SELECT space,memory_id,reserve_bytes,reserve_keys FROM memory_identity_ledger ORDER BY space,memory_id`,
        expected.sort(
          (a, b) => a.space.localeCompare(b.space) || a.memory_id.localeCompare(b.memory_id),
        ),
      );
      const revisionReads = statements.filter(
        (query) =>
          /FROM memory_revisions r LEFT JOIN memory_payloads p/.test(query) &&
          !query.includes("ORDER BY r.revision_id"),
      );
      const lineageReads = statements.filter(
        (query) =>
          /SELECT .*record_json FROM memory_import_lineage/.test(query) &&
          !query.includes("ORDER BY kind,key"),
      );
      assert.isAbove(revisionReads.length, 1);
      assert.isAbove(lineageReads.length, 1);
      assert.isBelow(revisionReads.length, 10);
      assert.isBelow(lineageReads.length, 10);
    }).pipe(Effect.provide(layer)),
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

it.effect("isolates an identity whose revision bodies exceed the migration batch budget", () =>
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
    yield* sql`UPDATE memory_payloads SET body_json=json_set(body_json,'$.text',${"x".repeat(16000)}) WHERE space=${space} AND payload_ref=${id(301)}`;
    yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<550)
      INSERT INTO memory_payloads(space,payload_ref,memory_id,body_json,dependencies_json)
      SELECT p.space,printf('00000000-0000-4000-8000-%012d',10000+n.i),p.memory_id,p.body_json,p.dependencies_json
      FROM memory_payloads p CROSS JOIN n WHERE p.space=${space} AND p.payload_ref=${id(301)}`;
    yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<550)
      INSERT INTO memory_revisions(space,revision_id,memory_id,operation_id,parents_json,scope_json,assertion_kind,provenance_json,payload_ref,created_at)
      SELECT r.space,printf('00000000-0000-4000-8000-%012d',10000+n.i),r.memory_id,r.operation_id,r.parents_json,r.scope_json,r.assertion_kind,r.provenance_json,printf('00000000-0000-4000-8000-%012d',10000+n.i),r.created_at
      FROM memory_revisions r CROSS JOIN n WHERE r.space=${space} AND r.revision_id=${id(301)}`;
    const statements: string[] = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (time, exit) => {
          end(time, exit);
          const query = span.attributes.get("db.query.text");
          if (typeof query === "string") statements.push(query);
        };
        return span;
      },
    });
    yield* sql.withTransaction(migration).pipe(Effect.withTracer(tracer));
    const revisionReads = statements.filter(
      (query) =>
        /FROM memory_revisions r LEFT JOIN memory_payloads p/.test(query) &&
        !query.includes("ORDER BY r.revision_id"),
    );
    assert.strictEqual(revisionReads.length, 3);
  }).pipe(Effect.provide(layer)),
);

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
