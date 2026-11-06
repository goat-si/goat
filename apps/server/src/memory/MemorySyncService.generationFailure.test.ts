import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sync from "./MemorySyncService.ts";
import { fixture, id, local, space } from "./MemorySyncService.testkit.ts";

const work = (key: string, thread: string, status: string, code: string | null, target = "") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const metadata = JSON.stringify({
      kind: "summary",
      sourceThread: { environmentId: local, threadId: thread },
      sourceWatermark: { throughSequence: key === "a-newer" ? 9 : 5 },
    });
    yield* sql`INSERT INTO memory_outbox(id,space,kind,status,metadata_json,next_attempt_at,failure_code)
      VALUES (${key},${target || space},'consolidate',${status},${metadata},0,${code})`;
    yield* sql`INSERT OR IGNORE INTO orchestration_v2_projection_threads(thread_id) VALUES (${thread})`;
  });

it.effect("reports summaries that failed for good only to a request that opts in", () =>
  Effect.gen(function* () {
    const sync = yield* Sync.MemorySyncService;
    const sql = yield* SqlClient.SqlClient;
    // Two failed chunks of one thread count once; retrying work and other spaces do not count.
    yield* work("a1", "a", "failed", "generation_failed");
    yield* work("a2", "a", "failed", "generation_failed");
    yield* work("b", "b", "retry", "generation_failed");
    yield* work("other", "c", "failed", "generation_failed", id(9));
    yield* work("d", "d", "failed", "generation_input_too_large");
    const legacy = yield* sync.syncStatus({}, Effect.void);
    assert.notProperty(legacy, "generationFailure");
    const status = () => sync.syncStatus({ includeGenerationFailure: true }, Effect.void);
    // Different reasons: none of them is presented as the reason for all.
    assert.deepStrictEqual((yield* status()).generationFailure, { threads: 2, failureCode: null });
    // A deleted thread's failure is gone before maintenance prunes the row.
    yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at='2026-11-07' WHERE thread_id='d'`;
    assert.deepStrictEqual((yield* status()).generationFailure, {
      threads: 1,
      failureCode: "generation_failed",
    });
    // Newer work of the thread supersedes its failure before maintenance prunes the row.
    yield* work("a-newer", "a", "pending", null);
    assert.notProperty(yield* status(), "generationFailure");
  }).pipe(Effect.provide(fixture())),
);
