import { assert, it } from "@effect/vitest";
import { ProjectId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionStore from "./ProjectionStore.ts";
import { createD10Thread, layerTest } from "./ProjectionStore.testkit.ts";

it.effect("thread-list pages count and order active threads before decoding their shells", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    for (const suffix of ["page-a", "page-b", "page-c"]) yield* createD10Thread(suffix);
    yield* sql`
      UPDATE orchestration_v2_projection_threads
      SET project_id = 'project:page',
          payload_json = json_set(payload_json, '$.projectId', 'project:page')
      WHERE thread_id IN ('thread:page-a', 'thread:page-b', 'thread:page-c')
    `;
    const [original] = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = 'thread:page-a'
    `;
    yield* sql`
      UPDATE orchestration_v2_projection_threads SET payload_json = '{invalid'
      WHERE thread_id = 'thread:page-a'
    `;
    const first = yield* store.listMcpThreadPage({
      projectId: ProjectId.make("project:page"),
      includeSubagents: true,
      offset: 0,
      limit: 2,
    });
    assert.equal(first.total, 3);
    assert.deepEqual(
      first.threads.map((thread) => thread.id),
      ["thread:page-c", "thread:page-b"],
    );
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${original!.payload_json}
      WHERE thread_id = 'thread:page-a'`;
    yield* sql`UPDATE orchestration_v2_projection_threads
      SET payload_json = json_set(payload_json, '$.settledOverride', 'settled')
      WHERE thread_id = 'thread:page-b'`;
    const settled = yield* store.listMcpThreadPage({
      projectId: ProjectId.make("project:page"),
      includeSubagents: true,
      settled: true,
      offset: 0,
      limit: 2,
    });
    assert.equal(settled.total, 1);
    assert.deepEqual(
      settled.threads.map((thread) => thread.id),
      ["thread:page-b"],
    );
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{invalid'
      WHERE thread_id = 'thread:page-a'`;
    const second = yield* store
      .listMcpThreadPage({
        projectId: ProjectId.make("project:page"),
        includeSubagents: true,
        offset: 2,
        limit: 1,
      })
      .pipe(Effect.flip);
    assert.equal(second._tag, "ProjectionStoreReadError");
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  ["SQL", layerTest],
  ["memory", ProjectionStore.layerMemory],
] as const)("%s pages preserve numeric offset behavior as threads are inserted", ([, layer]) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    for (const suffix of ["order-a", "order-b", "order-c"]) yield* createD10Thread(suffix);
    const first = yield* store.listMcpThreadPage({ includeSubagents: true, offset: 0, limit: 2 });
    assert.equal(first.total, 3);
    assert.deepEqual(
      first.threads.map((thread) => thread.id),
      ["thread:order-c", "thread:order-b"],
    );
    yield* createD10Thread("order-d");
    const second = yield* store.listMcpThreadPage({ includeSubagents: true, offset: 2, limit: 2 });
    assert.equal(second.total, 4);
    assert.deepEqual(
      second.threads.map((thread) => thread.id),
      ["thread:order-b", "thread:order-a"],
    );
  }).pipe(Effect.provide(layer)),
);
