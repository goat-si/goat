import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Settings from "../serverSettings.ts";
import * as Sync from "./MemorySyncService.ts";
import { fixture, local, space } from "./MemorySyncService.testkit.ts";

const work = (id: string, status: string, throughSequence: number, kind = "consolidate") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const metadata = JSON.stringify({
      kind: "summary",
      sourceThread: { environmentId: local, threadId: `thread-${id}` },
      sourceWatermark: { throughSequence },
    });
    yield* sql`INSERT INTO memory_outbox(id,space,kind,status,metadata_json,next_attempt_at,failure_code)
      VALUES (${id},${space},${kind},${status},${metadata},0,${status === "completed" ? null : "generation_failed"})`;
  });

it.effect(
  "reports failed summaries only to a request that opts in, and only while unreplaced",
  () =>
    Effect.gen(function* () {
      const sync = yield* Sync.MemorySyncService;
      const sql = yield* SqlClient.SqlClient;
      yield* work("a", "failed", 5);
      yield* work("b", "retry", 5);
      // A later completed run of the same conversation replaces its older failure.
      yield* work("c", "failed", 5);
      yield* sql`INSERT INTO memory_outbox(id,space,kind,status,metadata_json,next_attempt_at)
      SELECT 'c-later',space,kind,'completed',json_set(metadata_json,'$.sourceWatermark.throughSequence',9),0 FROM memory_outbox WHERE id='c'`;
      const legacy = yield* sync.syncStatus({}, Effect.void);
      assert.notProperty(legacy, "generationFailure");
      const opted = yield* sync.syncStatus({ includeGenerationFailure: true }, Effect.void);
      assert.deepStrictEqual(opted.generationFailure, {
        threads: 2,
        failureCode: "generation_failed",
        retrying: true,
      });
      // With memory off, queued summaries wait, so nothing is being retried.
      yield* (yield* Settings.ServerSettingsService).updateSettings({ memoryEnabled: false });
      const off = yield* sync.syncStatus({ includeGenerationFailure: true }, Effect.void);
      assert.strictEqual(off.generationFailure?.retrying, false);
    }).pipe(Effect.provide(fixture())),
);
