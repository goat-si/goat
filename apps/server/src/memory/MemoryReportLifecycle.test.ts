import { checkUsage } from "./MemoryUsageScan.testkit.ts";
import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Store from "./MemoryStore.ts";
import { reportMetadataBytes } from "./MemoryReportAccounting.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const memory = M.MemoryId.make(id(2));
const owner = M.EnvironmentId.make("A");
const other = M.EnvironmentId.make("B");
const reportId = (n: number) => n.toString(16).padStart(64, "0");
const database = Layer.effectDiscard(runMigrations()).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const live = Store.layer.pipe(Layer.provideMerge(database));
const insert = (n = 1, kind = "resolve", env: M.EnvironmentId = owner, approved = 1) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO memory_report_outbox(report_id,space,memory_id,operation_id,resolution_id,resolving_environment_id,outcome,state,created_at,report_kind,report_approved) VALUES (${reportId(n)},${space},${memory},${id(n + 10)},${id(7)},${env},${kind === "revert" ? "reverted" : kind === "conflict_failure" ? "failed" : "resolved"},'pending',${n},${kind},${approved})`;
  });
const acquire = (store: Store.MemoryStore["Service"], now: number, env = owner) =>
  store.acquireReports({ owner: env, now, until: now + 1000, limit: 1 });
const delivered = (report: M.MemoryReportDelivery): M.MemoryReportDelivery => ({
  ...report,
  state: "delivered",
  reportThread: {
    environmentId: report.resolvingEnvironmentId,
    threadId: M.ThreadId.make("report"),
  },
  sequence: 1,
});
const counters = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT space,dimension,scope_key,value FROM memory_quota_counters ORDER BY space,dimension,scope_key`;
});

describe("MemoryReportLifecycle", () => {
  it.effect("filters owner, kind, approval, due and exhausted rows before LIMIT", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* insert(0);
      yield* sql`UPDATE memory_report_outbox SET outcome='reverted' WHERE report_id=${reportId(0)}`;
      yield* insert(1, "summary");
      yield* insert(2, "unknown");
      yield* insert(3, "resolve", other);
      yield* insert(4, "resolve", owner, 0);
      yield* insert(5);
      yield* insert(6);
      yield* insert(7);
      yield* sql`UPDATE memory_report_outbox SET next_attempt_at=5000 WHERE report_id=${reportId(5)}`;
      yield* sql`UPDATE memory_report_outbox SET automatic_attempts=10 WHERE report_id=${reportId(6)}`;
      const rows = yield* acquire(store, 0);
      assert.deepStrictEqual(
        rows.map((r) => r.reportId),
        [reportId(7)],
      );
      assert.strictEqual(rows[0]!.automaticAttempts, 1);
      assert.strictEqual(yield* store.nextReportWakeAt(0, owner), 1000);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("rejects stale claimant acknowledgement and defer without changing counters", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const store = yield* Store.MemoryStore;
      yield* insert();
      const first = (yield* acquire(store, 0))[0]!;
      yield* TestClock.setTime(1000);
      const current = (yield* acquire(store, 1000))[0]!;
      const before = yield* counters;
      assert.isFalse(
        yield* store.acknowledgeClaimedReport({
          delivery: delivered(first),
          owner,
          claimUntil: 1000,
        }),
      );
      assert.isFalse(
        yield* store.deferClaimedReport({
          reportId: first.reportId,
          owner,
          claimUntil: 1000,
          failureCode: "unavailable",
          nextAttemptAt: 5000,
        }),
      );
      assert.deepStrictEqual(yield* counters, before);
      assert.isTrue(
        yield* store.acknowledgeClaimedReport({
          delivery: delivered(current),
          owner,
          claimUntil: 2000,
        }),
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("crashed tenth claim survives restart and never permits an eleventh attempt", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* insert();
      yield* sql`UPDATE memory_report_outbox SET automatic_attempts=9`;
      assert.strictEqual((yield* acquire(store, 0))[0]!.automaticAttempts, 10);
      assert.strictEqual(yield* store.nextReportWakeAt(0, owner), 1000);
      yield* store.normalizeExpiredReports(999);
      assert.strictEqual(
        (yield* sql<{ state: string }>`SELECT state FROM memory_report_outbox`)[0]!.state,
        "pending",
      );
      yield* TestClock.setTime(1000);
      const restarted = yield* Effect.service(Store.MemoryStore).pipe(Effect.provide(Store.layer));
      yield* restarted.normalizeExpiredReports(1000);
      assert.deepStrictEqual(yield* acquire(restarted, 1000), []);
      assert.isNull(yield* restarted.nextReportWakeAt(1000, owner));
      assert.deepStrictEqual(
        yield* sql`SELECT state,automatic_attempts,claimed_by,claimed_until FROM memory_report_outbox`,
        [{ state: "failed", automatic_attempts: 10, claimed_by: null, claimed_until: null }],
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("active tenth claim can defer, retains attempts and bounds backoff", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* insert();
      yield* sql`UPDATE memory_report_outbox SET automatic_attempts=9`;
      yield* acquire(store, 0);
      assert.isTrue(
        yield* store.deferClaimedReport({
          reportId: reportId(1),
          owner,
          claimUntil: 1000,
          failureCode: "unavailable",
          nextAttemptAt: 1,
        }),
      );
      assert.deepStrictEqual(
        yield* sql`SELECT state,automatic_attempts,next_attempt_at FROM memory_report_outbox`,
        [{ state: "failed", automatic_attempts: 10, next_attempt_at: 30000 }],
      );
      assert.isNull(yield* store.nextReportWakeAt(0, owner));
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("guard failure rolls acknowledgement and all counters back atomically", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* insert();
      const r = (yield* acquire(store, 0))[0]!;
      const before = yield* counters;
      yield* sql`CREATE TRIGGER reject_guard BEFORE INSERT ON memory_import_keys WHEN NEW.key_kind='report_delivered' BEGIN SELECT RAISE(ABORT,'synthetic guard refusal'); END`;
      assert.strictEqual(
        (yield* store
          .acknowledgeClaimedReport({ delivery: delivered(r), owner, claimUntil: 1000 })
          .pipe(Effect.exit))._tag,
        "Failure",
      );
      assert.deepStrictEqual(yield* counters, before);
      assert.deepStrictEqual(yield* sql`SELECT state,claimed_until FROM memory_report_outbox`, [
        { state: "pending", claimed_until: 1000 },
      ]);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect.each([owner, other])(
    "purges exact 30-day delivered details on local owner %s and retains target guard",
    (env) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(0);
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        yield* insert(1, "resolve", env);
        const r = (yield* acquire(store, 0, env))[0]!;
        yield* store.acknowledgeClaimedReport({
          delivery: delivered(r),
          owner: env,
          claimUntil: 1000,
        });
        assert.strictEqual(
          yield* store.nextReportMaintenanceAt(env),
          M.MEMORY_REPORT_DETAIL_RETENTION_MS,
        );
        assert.strictEqual(
          (yield* store.transact(
            store.purgeDeliveredReportDetailsTx({
              memorySpaceId: space,
              environmentId: env,
              now: M.MEMORY_REPORT_DETAIL_RETENTION_MS - 1,
              limit: 1,
            }),
          )).removedRows,
          0,
        );
        assert.strictEqual(
          (yield* store.transact(
            store.purgeDeliveredReportDetailsTx({
              memorySpaceId: space,
              environmentId: env,
              now: M.MEMORY_REPORT_DETAIL_RETENTION_MS,
              limit: 1,
            }),
          )).removedRows,
          1,
        );
        assert.deepStrictEqual(yield* store.readReportTarget(r.reportId), {
          memorySpaceId: space,
          memoryId: memory,
          deliveryEnvironmentId: env,
        });
        assert.strictEqual((yield* sql`SELECT 1 FROM memory_report_outbox`).length, 0);
        assert.strictEqual(
          (yield* sql`SELECT 1 FROM memory_import_keys WHERE key_kind='report_delivered'`).length,
          1,
        );
      }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("resets only exact-owner exhausted failed rows and does not free quota", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      for (let n = 1; n <= 32; n++) yield* insert(n);
      yield* insert(33, "resolve", other);
      yield* insert(34, "unknown");
      yield* insert(35);
      yield* sql`UPDATE memory_report_outbox SET state='failed',failure_code='unavailable',automatic_attempts=10 WHERE report_id!=${reportId(35)}`;
      const before = yield* counters;
      const result = yield* store.transact(
        store.resetReportAttemptsTx(
          {
            memorySpaceId: space,
            environmentId: owner,
            reportIds: Array.from({ length: 32 }, (_, i) => reportId(i + 1)),
          },
          0,
        ),
      );
      assert.deepStrictEqual(result, { resetCount: 32, unchangedCount: 0 });
      assert.deepStrictEqual(yield* counters, before);
      assert.deepStrictEqual(
        yield* store.transact(
          store.resetReportAttemptsTx(
            {
              memorySpaceId: space,
              environmentId: owner,
              reportIds: [reportId(1), reportId(33), reportId(34), reportId(35)],
            },
            0,
          ),
        ),
        { resetCount: 0, unchangedCount: 4 },
      );
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect(
    "quota equality admits 2000 retained unknown or exhausted rows and +1 refuses explicitly",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000) INSERT INTO memory_report_outbox(report_id,space,memory_id,operation_id,resolving_environment_id,outcome,state,created_at) SELECT printf('%064x',x),${space},${memory},${id(3)},${owner},'failed','pending',x FROM n`;
        assert.deepStrictEqual(
          yield* sql`SELECT value FROM memory_quota_counters WHERE space=${space} AND dimension='report_items'`,
          [{ value: 2000 }],
        );
        yield* insert(2001);
        assert.strictEqual(
          (yield* sql`SELECT report_id FROM memory_report_outbox WHERE report_id=${reportId(2001)}`)
            .length,
          0,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT value FROM memory_quota_counters WHERE space=${space} AND dimension='processing_admission_failures'`,
          [{ value: 1 }],
        );
      }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("metadata byte equality admits and +1 refuses while counters roll back", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insert();
      const bytes = (yield* sql.unsafe<{ bytes: number }>(
        `SELECT ${reportMetadataBytes()} AS bytes FROM memory_report_outbox`,
      ))[0]!.bytes;
      yield* sql`UPDATE memory_quota_counters SET value=${M.MEMORY_REPORT_MAX_PENDING_BYTES - bytes} WHERE space=${space} AND dimension='report_bytes'`;
      yield* insert(2);
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_report_outbox WHERE report_id=${reportId(2)}`).length,
        1,
      );
      yield* sql`UPDATE memory_quota_counters SET value=${M.MEMORY_REPORT_MAX_PENDING_BYTES - bytes + 1} WHERE space=${space} AND dimension='report_bytes'`;
      yield* insert(3);
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_report_outbox WHERE report_id=${reportId(3)}`).length,
        0,
      );
      const before = yield* counters;
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM memory_report_outbox`;
            return yield* Effect.fail("rollback");
          }),
        )
        .pipe(Effect.exit);
      assert.deepStrictEqual(yield* counters, before);
    }).pipe(checkUsage, Effect.provide(live)),
  );
  it.effect("A resolve and B revert keep immutable separate delivery owners", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      for (const [n, env, kind] of [
        [1, owner, "resolve"],
        [2, other, "revert"],
      ] as const) {
        const operationId = M.MemoryOperationId.make(id(n + 10));
        const resolutionId = M.MemoryResolutionId.make(id(7));
        const rid = Store.resolutionReportId(space, operationId, resolutionId);
        const record = M.MemoryCompactReceipt.make({
          memorySpaceId: space,
          originEnvironmentId: env,
          operationKind: kind,
          receipt: {
            operationId,
            memoryId: memory,
            operationDigest: "a".repeat(64),
            outcome: "accepted",
            hubSequence: n,
            ...(kind === "resolve"
              ? {
                  resolutionApproval: {
                    resolutionId,
                    appliedAtUtc: M.MemoryUtcTimestamp.make("2026-10-15T00:00:00.000Z"),
                    revertDeadlineUtc: M.MemoryUtcTimestamp.make("2026-11-14T00:00:00.000Z"),
                  },
                }
              : {}),
          },
          revisionId: M.MemoryRevisionId.make(id(n + 30)),
          resolutionId,
          revertsResolutionId: kind === "revert" ? resolutionId : null,
          attemptId: kind === "resolve" ? operationId : null,
          fencingToken: kind === "resolve" ? 1 : null,
          reportGuard: {
            reportId: rid,
            resolvingEnvironmentId: env,
            resolutionId,
            outcome: kind === "resolve" ? "resolved" : "reverted",
          },
        });
        assert.isFalse(
          (yield* store.transact(
            store.reconcileResolutionReportTx({
              record,
              localEnvironmentId: env === owner ? other : owner,
            }),
          )).deliverable,
        );
        assert.isTrue(
          (yield* store.transact(
            store.reconcileResolutionReportTx({ record, localEnvironmentId: env }),
          )).deliverable,
        );
      }
      assert.strictEqual((yield* acquire(store, 0, owner))[0]!.outcome, "resolved");
      assert.strictEqual((yield* acquire(store, 0, other))[0]!.outcome, "reverted");
    }).pipe(checkUsage, Effect.provide(live)),
  );
});

it.effect(
  "local maintenance purges delivered details from a former space and keeps failed rows",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* insert(1);
      yield* insert(2);
      const r = (yield* acquire(store, 0))[0]!;
      yield* store.acknowledgeClaimedReport({ delivery: delivered(r), owner, claimUntil: 1000 });
      const result = yield* store.transact(
        store.purgeDeliveredReportDetailsTx({
          environmentId: owner,
          now: M.MEMORY_REPORT_DETAIL_RETENTION_MS,
          limit: 1,
        }),
      );
      assert.strictEqual(result.removedRows, 1);
      assert.strictEqual(
        (yield* sql`SELECT 1 FROM memory_report_outbox WHERE report_id=${reportId(2)}`).length,
        1,
      );
      assert.isNull(yield* store.nextReportMaintenanceAt(owner));
    }).pipe(checkUsage, Effect.provide(live)),
);
it.effect("active tenth claim can acknowledge and target contradictions stay unavailable", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0);
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    yield* insert();
    yield* sql`UPDATE memory_report_outbox SET automatic_attempts=9`;
    const r = (yield* acquire(store, 0))[0]!;
    assert.isTrue(
      yield* store.acknowledgeClaimedReport({ delivery: delivered(r), owner, claimUntil: 1000 }),
    );
    yield* sql`UPDATE memory_import_keys SET record_json='{"operationId":"00000000-0000-4000-8000-000000000011","outcome":"resolved","resolvingEnvironmentId":"B"}' WHERE key_kind='report_delivered'`;
    assert.isNull(yield* store.readReportTarget(r.reportId));
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("delivered guards stay charged at the permanent metadata equality and +1 boundary", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0);
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    yield* insert(1);
    yield* insert(2);
    const reports = yield* store.acquireReports({ owner, now: 0, until: 1000, limit: 2 });
    const used = Effect.map(
      sql<{
        value: number;
      }>`SELECT value FROM memory_quota_counters WHERE space='_hub_global' AND dimension='hub_metadata' AND scope_key=''`,
      (rows) => rows[0]!.value,
    );
    const before = yield* used;
    let delta = 0;
    yield* store
      .transact(
        Effect.gen(function* () {
          yield* store.acknowledgeClaimedReport({
            delivery: delivered(reports[0]!),
            owner,
            claimUntil: 1000,
          });
          delta = (yield* used) - before;
          return yield* Effect.fail("rollback");
        }),
      )
      .pipe(Effect.exit);
    assert.isTrue(delta > 0);
    yield* sql`UPDATE memory_quota_counters SET value=${M.MEMORY_PERMANENT_METADATA_MAX_BYTES - delta} WHERE space='_hub_global' AND dimension='hub_metadata' AND scope_key=''`;
    assert.isTrue(
      yield* store.acknowledgeClaimedReport({
        delivery: delivered(reports[0]!),
        owner,
        claimUntil: 1000,
      }),
    );
    assert.strictEqual(yield* used, M.MEMORY_PERMANENT_METADATA_MAX_BYTES);
    yield* sql`UPDATE memory_quota_counters SET value=${M.MEMORY_PERMANENT_METADATA_MAX_BYTES - delta + 1} WHERE space='_hub_global' AND dimension='hub_metadata' AND scope_key=''`;
    const snapshot = yield* counters;
    const error = yield* store
      .acknowledgeClaimedReport({ delivery: delivered(reports[1]!), owner, claimUntil: 1000 })
      .pipe(Effect.flip);
    assert.strictEqual(error._tag, "MemoryCapacityError");
    assert.deepStrictEqual(yield* counters, snapshot);
    assert.strictEqual(
      (yield* sql`SELECT 1 FROM memory_import_keys WHERE key_kind='report_delivered'`).length,
      1,
    );
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("r2 M1 normalizes only canonically proven foreign pending intents", () =>
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    const operationId = M.MemoryOperationId.make(id(11));
    const resolutionId = M.MemoryResolutionId.make(id(7));
    const rid = Store.resolutionReportId(space, operationId, resolutionId);
    const record: M.MemoryCompactReceipt = {
      memorySpaceId: space,
      originEnvironmentId: other,
      operationKind: "revert",
      receipt: {
        operationId,
        memoryId: memory,
        operationDigest: "a".repeat(64),
        outcome: "accepted",
        hubSequence: 1,
      },
      revisionId: M.MemoryRevisionId.make(id(31)),
      resolutionId,
      revertsResolutionId: resolutionId,
      attemptId: null,
      fencingToken: null,
      reportGuard: {
        reportId: rid,
        resolvingEnvironmentId: other,
        resolutionId,
        outcome: "reverted",
      },
    };
    yield* store.persistCompactReceipt(record);
    yield* sql`INSERT INTO memory_report_outbox(report_id,space,memory_id,operation_id,resolution_id,resolving_environment_id,outcome,state,created_at) VALUES (${rid},${space},${memory},${operationId},${resolutionId},${other},'reverted','pending',0)`;
    yield* insert(2, "revert", other, 0); // No canonical evidence: retain.
    yield* insert(3); // Local: retain.
    const before = yield* sql<{
      value: number;
    }>`SELECT value FROM memory_quota_counters WHERE space=${space} AND dimension='report_items'`;
    yield* store.transact(store.normalizeForeignReportIntentsTx(owner));
    assert.deepStrictEqual(
      yield* sql`SELECT report_id FROM memory_report_outbox ORDER BY report_id`,
      [{ report_id: reportId(2) }, { report_id: reportId(3) }],
    );
    assert.deepStrictEqual(
      yield* sql`SELECT value FROM memory_quota_counters WHERE space=${space} AND dimension='report_items'`,
      [{ value: before[0]!.value - 1 }],
    );
    assert.strictEqual((yield* sql`SELECT 1 FROM memory_compact_receipts`).length, 1);
    const after = yield* counters;
    yield* store.transact(store.normalizeForeignReportIntentsTx(owner));
    assert.deepStrictEqual(yield* counters, after);
    assert.strictEqual((yield* acquire(store, 0, owner)).length, 1);
  }).pipe(checkUsage, Effect.provide(live)),
);

it.effect("r3 bounds PK pages before foreign filtering and releases the writer between pages", () =>
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    const sql = yield* SqlClient.SqlClient;
    // Three spaces, including unprovable foreign rows, local rows and delivered rows.
    yield* sql`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<600)
      INSERT INTO memory_report_outbox(report_id,space,memory_id,operation_id,resolution_id,resolving_environment_id,outcome,state,created_at,delivered_at,report_thread_json,delivered_sequence)
      SELECT printf('%064x',x), CASE WHEN x%3=0 THEN ${id(100)} WHEN x%3=1 THEN ${id(101)} ELSE ${space} END,${memory},${id(11)},${id(7)},CASE WHEN x%3=0 THEN ${owner} ELSE ${other} END,'reverted',CASE WHEN x%5=0 THEN 'delivered' ELSE 'pending' END,0,CASE WHEN x%5=0 THEN 0 ELSE NULL END,CASE WHEN x%5=0 THEN '{"environmentId":"B","threadId":"report"}' ELSE NULL END,CASE WHEN x%5=0 THEN 1 ELSE NULL END FROM n`;
    const before = yield* sql`SELECT * FROM memory_report_outbox ORDER BY report_id`;
    const usage = yield* counters;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const first = yield* store
      .transact(
        Effect.gen(function* () {
          const page = yield* store.normalizeForeignReportIntentsTx(owner);
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return page;
        }),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const attempted = yield* Deferred.make<void>();
    const competing = yield* Effect.gen(function* () {
      yield* Deferred.succeed(attempted, undefined);
      yield* store.transact(
        sql`UPDATE memory_report_outbox SET created_at=1 WHERE report_id=${reportId(600)}`,
      );
    }).pipe(Effect.forkChild);
    yield* Deferred.await(attempted);
    yield* Deferred.succeed(release, undefined);
    assert.deepStrictEqual(yield* Fiber.join(first), { examined: 256, nextCursor: reportId(256) });
    // A separate writer completes before the next page, without waiting for all 600 rows.
    yield* Fiber.join(competing);
    assert.deepStrictEqual(
      yield* store.transact(store.normalizeForeignReportIntentsTx(owner, reportId(256))),
      { examined: 256, nextCursor: reportId(512) },
    );
    assert.deepStrictEqual(
      yield* store.transact(store.normalizeForeignReportIntentsTx(owner, reportId(512))),
      { examined: 88, nextCursor: null },
    );
    yield* store.transact(
      sql`UPDATE memory_report_outbox SET created_at=0 WHERE report_id=${reportId(600)}`,
    );
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM memory_report_outbox ORDER BY report_id`,
      before,
    );
    assert.deepStrictEqual(yield* counters, usage);
  }).pipe(checkUsage, Effect.provide(live)),
);
