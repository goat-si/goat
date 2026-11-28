import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scheduler from "effect/Scheduler";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionStore from "./ProjectionStore.ts";
import { addRolledBackRecoveryCandidate, layerTest } from "./ProjectionStore.testkit.ts";

it.effect("large shell decoding lets another fiber run before it finishes", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const original = yield* addRolledBackRecoveryCandidate("shell-yield");
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, provider_instance_id,
         runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
      SELECT 'thread:shell-yield:' || i, project_id, title, default_provider, provider_instance_id,
        runtime_mode, interaction_mode, created_at, updated_at,
        json_set(payload_json, '$.id', 'thread:shell-yield:' || i,
          '$.lineage.rootThreadId', 'thread:shell-yield:' || i)
      FROM orchestration_v2_projection_threads, n WHERE thread_id = ${original}
    `;
    const decode = yield* sql.withTransaction(store.readShellSnapshot());
    let ran = false;
    const marker = yield* Effect.sync(() => {
      ran = true;
    }).pipe(Effect.forkChild);
    assert.isFalse(ran);
    const snapshot = yield* decode;
    assert.lengthOf(snapshot.threads, 301);
    assert.isTrue(ran);
    yield* Fiber.join(marker);
  }).pipe(
    Effect.provideService(Scheduler.MaxOpsBeforeYield, Number.POSITIVE_INFINITY),
    Effect.provide(layerTest),
  ),
);
