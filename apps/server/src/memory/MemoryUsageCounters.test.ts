import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Settings from "../serverSettings.ts";
import * as RepositoryResolver from "../project/RepositoryIdentityResolver.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Store from "./MemoryStore.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Service from "./MemoryService.ts";
import { memoryOperationDigest } from "./MemoryDecider.ts";
import { assertUsageCounters, scanUsage } from "./MemoryUsageScan.testkit.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const environmentId = M.EnvironmentId.make("fixture");
const database = Layer.effectDiscard(runMigrations()).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const store = Store.layer.pipe(Layer.provideMerge(database));
const serviceLive = (
  serviceLayer = Service.layer,
  readSettings: Settings.MemoryHubCommittedSettings["Service"]["read"] = Effect.succeed({
    provenance: null,
    settings: { mode: "hub" as const, memorySpaceId: space },
    version: 1,
  }),
) =>
  serviceLayer.pipe(
    Layer.provide(
      Layer.succeed(Settings.MemoryHubCommittedSettings, {
        read: readSettings,
      }),
    ),
    Layer.provide(
      Layer.mock(RepositoryResolver.RepositoryIdentityResolver)({
        resolve: () => Effect.succeed(null),
      }),
    ),
    Layer.provideMerge(Quota.layer.pipe(Layer.provideMerge(store))),
    Layer.provide(
      Layer.succeed(Environment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
  );
const live = serviceLive();

const decodeScope = Schema.decodeUnknownEffect(M.MemoryScope);
const decodeOperation = Schema.decodeUnknownSync(M.MemoryOperation);
const decodeOperationEffect = Schema.decodeUnknownEffect(M.MemoryOperation);
const operation = (n: number, chain = false): M.MemoryOperation =>
  decodeOperation({
    protocolVersion: 1,
    memorySpaceId: space,
    memoryId: id(chain ? 10 : 10000 + n),
    operationId: id(20000 + n),
    originEnvironmentId: environmentId,
    expectedHeads: chain && n > 0 ? [id(30000 + n - 1)] : [],
    kind: "upsert",
    revision: {
      memorySpaceId: space,
      memoryId: id(chain ? 10 : 10000 + n),
      revisionId: id(30000 + n),
      operationId: id(20000 + n),
      parents: chain && n > 0 ? [id(30000 + n - 1)] : [],
      scope: { kind: "user" },
      payloadRef: id(30000 + n),
      assertionKind: "inference",
      provenance: { environmentId },
      createdAtUtc: "2026-10-14T00:00:00.000Z",
    },
    payload: {
      text: "synthetic receive performance fixture",
      evidence: [],
      derivedFromMemoryRevisions: [],
    },
  });
const receive = (op: M.MemoryOperation, n: number) =>
  Effect.gen(function* () {
    const service = yield* Service.MemoryService;
    return yield* service.applyReceived(op, {
      operationId: op.operationId,
      memoryId: op.memoryId,
      operationDigest: memoryOperationDigest(op),
      outcome: "accepted",
      hubSequence: n + 1,
    });
  });
const check = Effect.gen(function* () {
  const storage = yield* Store.MemoryStore;
  assert.deepStrictEqual(
    yield* storage.usage(space, { kind: "user" }),
    yield* scanUsage(space, { kind: "user" }),
  );
});

it.effect(
  "received create/update, replay, forget, outbox, receipt replacement and rollback match scan",
  () =>
    Effect.gen(function* () {
      const storage = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* check;
      for (let n = 0; n < 5; n++) {
        yield* receive(operation(n, true), n);
        yield* check;
      }
      yield* receive(operation(4, true), 4);
      yield* check;
      const before = yield* storage.usage(space, { kind: "user" });
      const rollback = yield* storage
        .transact(receive(operation(5, true), 5).pipe(Effect.andThen(Effect.fail("rollback"))))
        .pipe(Effect.exit);
      assert.deepStrictEqual(rollback, Exit.fail("rollback"));
      assert.deepStrictEqual(yield* storage.usage(space, { kind: "user" }), before);
      yield* check;
      yield* sql`UPDATE memory_revisions SET provenance_json=json_set(provenance_json,'$.sourceThread',json('{"environmentId":"fixture","threadId":"synthetic"}'),'$.sourceWatermark',json('{"fromEventId":"synthetic-from","toEventId":"synthetic-to","throughSequence":1}')) WHERE revision_id=${id(30004)}`;
      yield* check;
      yield* sql`UPDATE memory_payloads SET body_json=json_set(body_json,'$.text','한글 synthetic replacement') WHERE payload_ref=${id(30004)}`;
      yield* check;
      yield* sql`INSERT INTO memory_outbox(id,space,memory_id,kind,status,metadata_json,attempt,next_attempt_at) VALUES ('test',${space},${id(10)},'admin','pending','{}',0,0)`;
      yield* check;
      yield* sql`UPDATE memory_outbox SET status='completed' WHERE id='test'`;
      yield* check;
      yield* sql`DELETE FROM memory_outbox WHERE id='test'`;
      yield* check;
      const service = yield* Service.MemoryService;
      const op = yield* decodeOperationEffect({
        protocolVersion: 1,
        memorySpaceId: space,
        memoryId: id(10),
        operationId: id(90000),
        originEnvironmentId: environmentId,
        expectedHeads: [id(30004)],
        kind: "forget",
        tombstone: {
          memorySpaceId: space,
          memoryId: id(10),
          deleteOperationId: id(90000),
          deletingEnvironmentId: environmentId,
          deletedAtUtc: "2026-10-14T00:00:00.000Z",
          suppressedSourceKeys: [],
          suppressedContent: [],
          sourceExclusions: [],
        },
      });
      yield* service.applyReceived(op, {
        operationId: op.operationId,
        memoryId: op.memoryId,
        operationDigest: memoryOperationDigest(op),
        outcome: "deleted",
        hubSequence: 10,
      });
      yield* check;
      yield* sql`DELETE FROM memory_revisions WHERE space=${space}`;
      yield* check;
      yield* sql`DELETE FROM memory_events WHERE memory_space_id=${space}`;
      yield* check;
      yield* sql`DELETE FROM memory_compact_receipts WHERE space=${space}`;
      yield* check;
    }).pipe(Effect.provide(live)),
);

it.effect("oracle checks vanished scopes, empty spaces, and compact/outbox-only spaces", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const storage = yield* Store.MemoryStore;
    const scopes = [
      { kind: "project", projectKey: { kind: "repository", groupingKey: "repo:synthetic" } },
      { kind: "project", projectKey: { kind: "explicit", sharedProjectId: "synthetic" } },
      { kind: "thread", thread: { environmentId: "한:env", threadId: "synthetic:thread" } },
    ];
    const keys = [
      "repository:repo:synthetic",
      "explicit:synthetic",
      "thread:5:한:env:synthetic:thread",
    ];
    yield* sql`INSERT INTO memory_items(space,memory_id,scope_json,scope_key,heads_json,status,projection_watermark,item_json,availability_json) VALUES (${space},'last',${JSON.stringify(scopes[0])},${keys[0]!},'[]','active',0,'{}','{}')`;
    for (let n = 1; n < scopes.length; n++) {
      yield* sql`UPDATE memory_items SET scope_json=${JSON.stringify(scopes[n])},scope_key=${keys[n]!} WHERE space=${space}`;
      yield* assertUsageCounters;
      const previous = yield* decodeScope(scopes[n - 1]);
      assert.strictEqual((yield* storage.usage(space, previous)).scopeItems, 0);
      // A stale old scope must be discovered even though it has no remaining item.
      yield* sql`UPDATE memory_quota_counters SET value=1 WHERE space=${space} AND dimension='usage_items' AND scope_key=${keys[n - 1]!}`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(assertUsageCounters)));
      yield* sql`UPDATE memory_quota_counters SET value=0 WHERE space=${space} AND dimension='usage_items' AND scope_key=${keys[n - 1]!}`;
    }
    yield* sql`DELETE FROM memory_items WHERE space=${space}`;
    yield* assertUsageCounters;
    assert.isTrue(
      Object.values(yield* storage.usage(space, { kind: "user" })).every((n) => n === 0),
    );
    yield* sql`UPDATE memory_quota_counters SET value=1 WHERE space=${space} AND dimension='usage_items' AND scope_key=''`;
    assert.isTrue(Exit.isFailure(yield* Effect.exit(assertUsageCounters)));
    yield* sql`UPDATE memory_quota_counters SET value=0 WHERE space=${space} AND dimension='usage_items' AND scope_key=''`;
    const compactSpace = id(700);
    const outboxSpace = id(701);
    yield* sql`INSERT INTO memory_compact_receipts(space,operation_id,operation_digest,hub_sequence,receipt_json,compact_json) VALUES (${compactSpace},'op','digest',1,'{}','{}')`;
    yield* sql`INSERT INTO memory_outbox(id,space,memory_id,kind,status,metadata_json,attempt,next_attempt_at) VALUES ('only',${outboxSpace},'memory','admin','pending','{}',0,0)`;
    yield* assertUsageCounters;
    for (const [address, dimension] of [
      [compactSpace, "usage_receipts"],
      [outboxSpace, "usage_work_items"],
    ]) {
      // Remove its counters to prove the contributing table itself supplies this address.
      const rows =
        yield* sql`DELETE FROM memory_quota_counters WHERE space=${address!} RETURNING *`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(assertUsageCounters)), dimension);
      for (const row of rows) yield* sql`INSERT INTO memory_quota_counters ${sql.insert(row)}`;
    }
    yield* sql`DELETE FROM memory_compact_receipts WHERE space=${compactSpace}`;
    yield* sql`DELETE FROM memory_outbox WHERE space=${outboxSpace}`;
    yield* assertUsageCounters;
    for (const address of [space, compactSpace, outboxSpace])
      assert.isTrue(
        Object.values(yield* storage.usage(M.MemorySpaceId.make(address), { kind: "user" })).every(
          (n) => n === 0,
        ),
      );
  }).pipe(Effect.provide(live)),
);
