import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Settings from "../serverSettings.ts";
import * as RepositoryResolver from "../project/RepositoryIdentityResolver.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Store from "./MemoryStore.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Service from "./MemoryService.ts";
import { memoryOperationDigest } from "./MemoryDecider.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const memory = M.MemoryId.make(id(10));
const environmentId = M.EnvironmentId.make("fixture");
const revisionId = (n: number) => M.MemoryRevisionId.make(id(30000 + n));
const sourceThread = { environmentId, threadId: "thread" };
const sourceWatermark = { fromEventId: id(100), toEventId: id(101), throughSequence: 1 };
const database = Layer.effectDiscard(runMigrations()).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const store = Store.layer.pipe(Layer.provideMerge(database));
const live = Service.layer.pipe(
  Layer.provide(
    Layer.succeed(Settings.MemoryHubCommittedSettings, {
      read: Effect.succeed({
        provenance: null,
        settings: { mode: "hub" as const, memorySpaceId: space },
        version: 1,
      }),
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

const decodeOperation = Schema.decodeUnknownSync(M.MemoryOperation);
/** One link of a single-memory chain; `source` revisions carry thread evidence. */
const operation = (n: number, source = false): M.MemoryOperation =>
  decodeOperation({
    protocolVersion: 1,
    memorySpaceId: space,
    memoryId: memory,
    operationId: id(20000 + n),
    originEnvironmentId: environmentId,
    expectedHeads: n > 0 ? [revisionId(n - 1)] : [],
    kind: "upsert",
    revision: {
      memorySpaceId: space,
      memoryId: memory,
      revisionId: revisionId(n),
      operationId: id(20000 + n),
      parents: n > 0 ? [revisionId(n - 1)] : [],
      scope: { kind: "user" },
      payloadRef: revisionId(n),
      assertionKind: "inference",
      provenance: source ? { environmentId, sourceThread, sourceWatermark } : { environmentId },
      createdAtUtc: "2026-10-14T00:00:00.000Z",
    },
    payload: {
      text: `revision ${n}`,
      evidence: source
        ? [
            {
              origin: "thread",
              sourceThread,
              watermark: sourceWatermark,
              messageIds: [`message-${n}`],
            },
          ]
        : [],
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
const chain = (count: number, source: (n: number) => boolean = () => false) =>
  Effect.forEach(
    Array.from({ length: count }, (_, n) => n),
    (n) => receive(operation(n, source(n)), n),
    {
      discard: true,
    },
  );
/** Valid JSON that no payload codec accepts, so any decode of these rows fails. */
const corruptPayloads = (keep: ReadonlyArray<M.MemoryRevisionId>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE memory_payloads SET body_json='{"invalid":true}' WHERE space=${space} AND payload_ref IN (
      SELECT payload_ref FROM memory_revisions WHERE space=${space} AND memory_id=${memory} AND revision_id NOT IN ${sql.in(keep)})`;
  });

describe("memory admission payload reads", () => {
  it.effect("receives the next revision of a long chain without decoding its history", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      const sql = yield* SqlClient.SqlClient;
      yield* chain(12);
      yield* corruptPayloads([revisionId(11)]);
      const full = yield* store.loadAggregate(space, memory).pipe(Effect.flip);
      assert.instanceOf(full, Store.MemoryStorageError);
      assert.strictEqual(full.stage, "payload-codec");

      const queries: Array<readonly [string, ReadonlyArray<unknown>]> = [];
      const record: Statement.Transformer = (statement) =>
        Effect.sync(() => {
          queries.push(statement.compile());
          return statement;
        });
      const received = yield* receive(operation(12), 12).pipe(
        Effect.provideService(Statement.CurrentTransformer, record),
      );
      assert.strictEqual(received.receipt.outcome, "accepted");
      assert.deepStrictEqual((yield* store.loadAggregate(space, memory, { heads: true })).heads, [
        revisionId(12),
      ]);
      // Every selected payload read binds the space plus at most one head reference.
      const payloadReads = queries.filter(([query]) =>
        query.includes("SELECT payload_ref,body_json FROM memory_payloads"),
      );
      assert.isAbove(payloadReads.length, 0);
      for (const [query, params] of payloadReads) {
        assert.isAtMost(params.length, 2);
        assert.isAtMost((yield* sql.unsafe(query, params)).length, 1);
      }
    }).pipe(Effect.provide(live)),
  );

  it.effect("keeps the full DAG and decodes exactly the selected payloads", () =>
    Effect.gen(function* () {
      const store = yield* Store.MemoryStore;
      yield* chain(6, (n) => n % 2 === 0);
      const full = yield* store.loadAggregate(space, memory);
      const heads = yield* store.loadAggregate(space, memory, { heads: true });
      const sources = yield* store.loadAggregate(space, memory, {
        when: Store.hasSourceEvidence,
      });
      const listed = yield* store.loadAggregate(space, memory, {
        revisionIds: [revisionId(1)],
      });
      const rest = (aggregate: Store.MemoryAggregate) => ({ ...aggregate, revisions: [] });
      for (const [selected, keep] of [
        [
          heads,
          (pair: Store.MemoryAggregate["revisions"][number]) =>
            full.heads.includes(pair.revision.revisionId),
        ],
        [
          sources,
          (pair: Store.MemoryAggregate["revisions"][number]) =>
            Store.hasSourceEvidence(pair.revision),
        ],
        [
          listed,
          (pair: Store.MemoryAggregate["revisions"][number]) =>
            pair.revision.revisionId === revisionId(1),
        ],
      ] as const) {
        assert.deepStrictEqual(rest(selected), rest(full));
        assert.deepStrictEqual(
          selected.revisions.map((pair) => pair.revision),
          full.revisions.map((pair) => pair.revision),
        );
        assert.deepStrictEqual(
          selected.revisions.map((pair) => pair.payload),
          full.revisions.map((pair) => (keep(pair) ? pair.payload : null)),
        );
      }
      assert.isTrue(sources.revisions.some((pair) => pair.payload !== null));
    }).pipe(Effect.provide(live)),
  );

  it.effect(
    "counts non-head source evidence in the forget reservation without reading other history",
    () =>
      Effect.gen(function* () {
        const store = yield* Store.MemoryStore;
        yield* chain(6, (n) => n === 1);
        const before = yield* store.transact(store.firstForgetReservation(operation(6)));
        assert.isAtLeast(before.keys, 1);
        yield* corruptPayloads([revisionId(1), revisionId(5)]);
        assert.deepStrictEqual(
          yield* store.transact(store.firstForgetReservation(operation(6))),
          before,
        );
      }).pipe(Effect.provide(live)),
  );
});
