import lineageMigration from "./081_MemoryImportLineage.ts";
import checkpointMigration from "./082_MemoryCheckpointAccounting.ts";
import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as Store from "../../memory/MemoryStore.ts";
import migration from "./079_MemorySearchCounters.ts";

const database = Layer.effectDiscard(runMigrations({ toMigrationInclusive: 78 })).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const live = Store.layer.pipe(Layer.provideMerge(database));
const space = M.MemorySpaceId.make("00000000-0000-4000-8000-000000000001");
const filter = { memorySpaceId: space, scope: { kind: "user" as const }, limit: 100 };
it.effect(
  "defers old rows, resumes bounded backfill, and rolls back its cursor with counters",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* Store.MemoryStore;
      yield* sql`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<1001)
      INSERT INTO memory_items(space,memory_id,scope_json,scope_key,heads_json,status,projection_watermark,item_json,availability_json)
      SELECT ${space},printf('00000000-0000-4000-8000-%012d',n),'{}','user','[]','quarantined',0,'{}','{}' FROM ids`;
      const text = "synthetic old indexed text";
      yield* sql`INSERT INTO memory_payloads(space,payload_ref,memory_id,body_json,dependencies_json) VALUES (${space},'old-ref','old-memory',${JSON.stringify({ text, evidence: [], derivedFromMemoryRevisions: [] })},'[]')`;
      yield* sql`UPDATE memory_items SET status='active',payload_ref='old-ref',index_state='ready',indexed_generation=generation`;
      const indexesBefore =
        yield* sql`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_items' ORDER BY name`;
      yield* migration;
      yield* lineageMigration;
      yield* checkpointMigration;
      assert.deepStrictEqual(yield* sql`SELECT * FROM memory_search_counters`, []);
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_items' ORDER BY name`,
        indexesBefore,
      );
      yield* store
        .transact(
          Effect.gen(function* () {
            const coverage = yield* store.searchCoverage(filter);
            assert.deepStrictEqual(coverage, {
              ready: false,
              eligible: 1000,
              indexed: 1000,
              textBytes: 1000 * new TextEncoder().encode(text).length,
            });
            assert.deepStrictEqual(
              yield* sql`SELECT after_rowid,ready FROM memory_search_backfill`,
              [{ after_rowid: 1000, ready: 0 }],
            );
            return yield* new Store.MemoryStoreConflict({ code: "unavailable" });
          }),
        )
        .pipe(Effect.flip);
      assert.deepStrictEqual(yield* sql`SELECT after_rowid,ready FROM memory_search_backfill`, [
        { after_rowid: 0, ready: 0 },
      ]);
      assert.deepStrictEqual(yield* sql`SELECT * FROM memory_search_counters`, []);
      assert.deepStrictEqual(
        yield* sql`SELECT count(*) AS n FROM memory_items WHERE search_counted=1`,
        [{ n: 0 }],
      );
      const refused = yield* store.search(filter, "synthetic", "substring").pipe(Effect.flip);
      assert.isTrue("code" in refused && refused.code === "unavailable");
      assert.deepStrictEqual(yield* sql`SELECT after_rowid,ready FROM memory_search_backfill`, [
        { after_rowid: 1000, ready: 0 },
      ]);
      assert.deepStrictEqual(
        yield* sql`SELECT count(*) AS n FROM memory_items WHERE search_counted=1`,
        [{ n: 1000 }],
      );
      yield* sql`DELETE FROM memory_items WHERE rowid=1001`;
      yield* sql`INSERT INTO memory_items(space,memory_id,scope_json,scope_key,heads_json,status,projection_watermark,item_json,availability_json) VALUES (${space},'00000000-0000-4000-8000-000000002000','{}','user','[]','quarantined',0,'{}','{}')`;
      assert.isTrue((yield* store.searchCoverage(filter)).ready);
      assert.deepStrictEqual(
        yield* sql`SELECT count(*) AS n FROM memory_items WHERE search_counted=0`,
        [{ n: 0 }],
      );
    }).pipe(Effect.provide(live)),
);
