import * as M from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import packageJson from "../../package.json" with { type: "json" };
import { DatabaseNewerThanBuildError } from "./Errors.ts";
import { publishMemoryOriginUpdatesTx } from "../memory/MemoryOriginReplication.ts";
import { MemoryStore, layer as memoryStore } from "../memory/MemoryStore.ts";
import { migrationEntries, runMigrations } from "./Migrations.ts";
import { assertMemoryMigrationsCompatible } from "./reconcileGoatMigrationIds.ts";

const isDatabaseNewerThanBuildError = Schema.is(DatabaseNewerThanBuildError);

const displacedGoatId = Math.max(...migrationEntries.map(([id]) => id)) + 100;

describe("runMigrations database ahead of this build", () => {
  it.effect(
    "fails with DatabaseNewerThanBuildError when a newer build recorded an unknown migration",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 60 });
        // ServerActivityIndexes belongs at 90. A newer build already recorded
        // its own migration on that id, so reconciliation cannot move it.
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (61, 'ServerActivityIndexes')
        `;
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (90, 'FutureUpstreamMigration')
        `;

        const exit = yield* Effect.exit(runMigrations());
        assert.strictEqual(exit._tag, "Failure");
        if (exit._tag !== "Failure") return;
        const failure = Cause.squash(exit.cause);
        assert.strictEqual(M.SERVER_EXIT_CODE_DATABASE_AHEAD, 79);
        assert.strictEqual(Runtime.getErrorExitCode(failure), M.SERVER_EXIT_CODE_DATABASE_AHEAD);
        assert.isTrue(isDatabaseNewerThanBuildError(failure));
        if (!isDatabaseNewerThanBuildError(failure)) return;
        assert.deepStrictEqual(failure.unknownMigrations, ["FutureUpstreamMigration"]);
        assert.strictEqual(
          failure.originalMessage,
          "Cannot move GOAT migrations onto ids another migration recorded.",
        );
        assert.strictEqual(failure[Runtime.errorExitCode], 79);
        assert.strictEqual(
          failure.message,
          `This database was upgraded by a newer GOAT build; GOAT ${packageJson.version} cannot open it. Start that newer build, or update GOAT. Unknown migrations: FutureUpstreamMigration.`,
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("the 157 build refuses a migrated 158 memory database", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual((yield* runMigrations({ toMigrationInclusive: 158 })).at(-1), [
        158,
        "MemoryThreadLineage",
      ]);
      const manifest157 = migrationEntries.filter(([id]) => id <= 157);
      const failure = yield* Effect.flip(assertMemoryMigrationsCompatible(manifest157));
      assert.strictEqual(failure._tag, "MigrationError");
      if (failure._tag !== "MigrationError") return;
      assert.strictEqual(failure.kind, "BadState");
      assert.include(failure.message, "Unreleased memory DB is incompatible");
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("the 159 build refuses a migrated 160 hub floor database", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual((yield* runMigrations({ toMigrationInclusive: 160 })).at(-1), [
        160,
        "MemoryHubFloor",
      ]);
      const manifest159 = migrationEntries.filter(([id]) => id <= 159);
      const failure = yield* Effect.flip(assertMemoryMigrationsCompatible(manifest159));
      assert.strictEqual(failure._tag, "MigrationError");
      assert.include(failure.message, "Unreleased memory DB is incompatible");
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("the 160 build refuses a migrated scope-version database", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual((yield* runMigrations({ toMigrationInclusive: 161 })).at(-1), [
        161,
        "MemoryScopeVersion",
      ]);
      const manifest160 = migrationEntries.filter(([id]) => id <= 160);
      const failure = yield* Effect.flip(assertMemoryMigrationsCompatible(manifest160));
      assert.strictEqual(failure._tag, "MigrationError");
      assert.include(failure.message, "Unreleased memory DB is incompatible");
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("repairs only the kind byte of historical compact move receipts", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 161 });
      yield* sql`INSERT INTO memory_compact_receipts
        (space,operation_id,operation_digest,hub_sequence,receipt_json,compact_json,compact_blob)
        VALUES
          ('synthetic','old-move','d',1,'{}','{"operationKind":"move"}',X'02FF0000AFFE00'),
          ('synthetic','old-upsert','d',2,'{}','{"operationKind":"upsert"}',X'02000000AFFE00'),
          ('synthetic','new-move','d',3,'{}','{"operationKind":"move"}',X'02040300AFFE00')`;
      yield* runMigrations();
      assert.deepStrictEqual(
        yield* sql`SELECT operation_id,hex(compact_blob) AS binary FROM memory_compact_receipts ORDER BY hub_sequence`,
        [
          { operation_id: "old-move", binary: "02040000AFFE00" },
          { operation_id: "old-upsert", binary: "02000000AFFE00" },
          { operation_id: "new-move", binary: "02040300AFFE00" },
        ],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "migration 160 preserves suggestion forget generations and backfills the hub watermark",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 159 });
        yield* sql`INSERT INTO memory_space_counters(space,forget_generation) VALUES ('synthetic',7)`;
        yield* sql`INSERT INTO memory_hub_retention(space,checkpoint_sequence) VALUES ('synthetic',11)`;
        assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 160 }), [
          [160, "MemoryHubFloor"],
        ]);
        assert.deepStrictEqual(
          yield* sql`SELECT forget_generation,last_forget_sequence FROM memory_space_counters WHERE space='synthetic'`,
          [{ forget_generation: 7, last_forget_sequence: 11 }],
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("backfills origin catch-up on a ready database and publishes the next sequence", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const upgrade = migrationEntries.find(([, name]) => name === "MemoryOriginCatchup");
      if (!upgrade) throw new Error("Expected the origin catch-up migration");
      const [migrationId, migrationName] = upgrade;
      yield* runMigrations({ toMigrationInclusive: migrationId - 1 });
      const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      const space = M.MemorySpaceId.make(id(1));
      const secondSpace = M.MemorySpaceId.make(id(2));
      const environmentId = M.EnvironmentId.make("synthetic-upgrade-member");
      const hubId = M.EnvironmentId.make("synthetic-upgrade-hub");
      const addIdentity = Effect.fn("test.addOriginUpgradeIdentity")(function* (
        memorySpaceId: M.MemorySpaceId,
        n: number,
        originState: "published" | "unpublished" | "new",
        threadId = M.ThreadId.make(`synthetic-thread-${n}`),
      ) {
        const memoryId = M.MemoryId.make(id(n));
        const createOperationId = M.MemoryOperationId.make(id(n + 100));
        const identity = {
          memorySpaceId,
          memoryId,
          creatingEnvironmentId: environmentId,
          createOperationId,
          createdAtUtc: "2026-10-14T00:00:00.000Z",
          scope: { kind: "user" },
          ...(originState === "published" ? { origin: { environmentId, threadId } } : {}),
        };
        const fence = { memorySpaceId, memoryId, highestFencingToken: 0, activeLease: null };
        yield* sql`INSERT INTO memory_identity_ledger(space,memory_id,identity_json,fence_json,reserve_bytes)
          VALUES (${memorySpaceId},${memoryId},${JSON.stringify(identity)},${JSON.stringify(fence)},0)`;
        if (originState !== "new")
          yield* sql`INSERT INTO memory_origins(space,memory_id,environment_id,thread_id)
            VALUES (${memorySpaceId},${memoryId},${environmentId},${threadId})`;
        return { memoryId, createOperationId, threadId };
      });
      const published = yield* addIdentity(space, 10, "published");
      const oversized = yield* addIdentity(
        space,
        11,
        "published",
        M.ThreadId.make('"'.repeat(33_000)),
      );
      const unpublished = yield* addIdentity(space, 12, "unpublished");
      const anotherSpace = yield* addIdentity(secondSpace, 13, "published");
      const fresh = yield* addIdentity(space, 14, "new");
      yield* sql`INSERT INTO memory_sync_cursors(space,hub_environment_id,after_sequence,bootstrap_state)
        VALUES (${space},${hubId},42,'ready')`;
      yield* sql`INSERT INTO memory_space_counters(space,forget_generation,last_forget_sequence)
        VALUES (${space},7,41),(${secondSpace},11,13)`;

      assert.deepStrictEqual(yield* runMigrations(), [[migrationId, migrationName]]);
      assert.deepStrictEqual(
        yield* sql`SELECT space,memory_id,origin_sequence FROM memory_origins ORDER BY space,memory_id`,
        [
          { space, memory_id: published.memoryId, origin_sequence: 1 },
          { space, memory_id: oversized.memoryId, origin_sequence: 2 },
          { space, memory_id: unpublished.memoryId, origin_sequence: 0 },
          { space: secondSpace, memory_id: anotherSpace.memoryId, origin_sequence: 1 },
        ],
      );
      const counters = sql`SELECT space,forget_generation,last_forget_sequence,origin_update_sequence
        FROM memory_space_counters WHERE space IN (${space},${secondSpace}) ORDER BY space`;
      const before = [
        { space, forget_generation: 7, last_forget_sequence: 41, origin_update_sequence: 2 },
        {
          space: secondSpace,
          forget_generation: 11,
          last_forget_sequence: 13,
          origin_update_sequence: 1,
        },
      ];
      assert.deepStrictEqual(yield* counters, before);
      assert.deepStrictEqual(
        yield* sql`SELECT after_sequence,after_origin_sequence,bootstrap_state FROM memory_sync_cursors WHERE space=${space}`,
        [{ after_sequence: 42, after_origin_sequence: 0, bootstrap_state: "ready" }],
      );
      const ledger = sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      const upgradedLedger = yield* ledger;
      assert.isEmpty(yield* runMigrations());
      assert.deepStrictEqual(yield* ledger, upgradedLedger);
      const manifest = migrationEntries.filter(([id]) => id < migrationId);
      const failure = yield* Effect.flip(assertMemoryMigrationsCompatible(manifest));
      assert.include(failure.message, "Unreleased memory DB is incompatible");

      const receipt = {
        operationId: fresh.createOperationId,
        memoryId: fresh.memoryId,
        outcome: "accepted",
        operationDigest: "a".repeat(64),
        hubSequence: 43,
      };
      const compact = {
        memorySpaceId: space,
        originEnvironmentId: environmentId,
        operationKind: "upsert",
        receipt,
        revisionId: id(114),
        resolutionId: null,
        revertsResolutionId: null,
        attemptId: null,
        fencingToken: null,
        reportGuard: null,
      };
      yield* sql`INSERT INTO memory_compact_receipts(space,operation_id,operation_digest,hub_sequence,receipt_json,compact_json)
        VALUES (${space},${receipt.operationId},${receipt.operationDigest},43,${JSON.stringify(receipt)},${JSON.stringify(compact)})`;
      const store = yield* MemoryStore;
      yield* store.transact(
        publishMemoryOriginUpdatesTx(sql, { memorySpaceId: space, environmentId }, [fresh]),
      );
      assert.deepStrictEqual(yield* counters, [
        { ...before[0], origin_update_sequence: 3 },
        before[1],
      ]);
      const page = yield* store.transact(store.readOriginPageTx(space, 1));
      assert.deepStrictEqual(page, {
        updates: [{ ...fresh, sequence: 3, environmentId }],
        throughSequence: 3,
        hasMore: false,
      });
      const fromReadyCursor = yield* store.transact(store.readOriginPageTx(space, 0));
      yield* store.transact(store.receiveOriginPageTx(space, hubId, 0, fromReadyCursor));
      assert.equal(yield* store.readOriginCursor(space, hubId), fromReadyCursor.throughSequence);
      assert.equal(yield* store.readCursor(space, hubId), 42);
    }).pipe(
      Effect.provide(
        memoryStore.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" }))),
      ),
    ),
  );

  it.effect("keeps MigrationError when a failing ledger only contains known names", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 64 });
      yield* sql`
        UPDATE effect_sql_migrations
        SET name = 'ThreadFailureLookupIndex'
        WHERE migration_id = 61
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${displacedGoatId}, 'ServerActivityIndexes')
      `;

      const failure = yield* Effect.flip(runMigrations());
      assert.strictEqual(failure._tag, "MigrationError");
      if (failure._tag !== "MigrationError") return;
      assert.strictEqual(failure.kind, "BadState");
      assert.strictEqual(
        failure.message,
        "Migration 61 is recorded as ThreadFailureLookupIndex, expected PullRequestReviewGuides.",
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
