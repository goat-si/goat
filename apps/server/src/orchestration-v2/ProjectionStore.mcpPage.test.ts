import { assert, it } from "@effect/vitest";
import { EventId, MessageId, NodeId, ProjectId, RunId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  createD10Thread,
  driver,
  layerTest,
  modelSelection,
  providerInstanceId,
} from "./ProjectionStore.testkit.ts";

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

it.effect("title filtering matches JavaScript Unicode case folding before paging", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    yield* createD10Thread("title-a");
    yield* createD10Thread("title-b");
    yield* sql`UPDATE orchestration_v2_projection_threads
      SET title = 'Kelvin', payload_json = json_set(payload_json, '$.title', 'Kelvin')
      WHERE thread_id = 'thread:title-a'`;
    yield* sql`UPDATE orchestration_v2_projection_threads
      SET title = 'Other', payload_json = json_set(payload_json, '$.title', 'Other')
      WHERE thread_id = 'thread:title-b'`;
    const page = yield* store.listMcpThreadPage({
      includeSubagents: true,
      titleContains: "k",
      offset: 0,
      limit: 1,
    });
    assert.equal(page.total, 1);
    assert.deepEqual(
      page.threads.map((thread) => thread.id),
      ["thread:title-a"],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  ["SQL", layerTest],
  ["memory", ProjectionStore.layerMemory],
] as const)("%s pages filter active run statuses before decoding", ([, layer]) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    yield* createD10Thread("status-idle");
    const threadId = yield* createD10Thread("status-running");
    const now = yield* DateTime.now;
    const runId = RunId.make("run:status-running");
    const nodeId = NodeId.make("node:status-running");
    yield* store.apply({
      id: EventId.make("event:status-running"),
      type: "run.created",
      threadId,
      runId,
      nodeId,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:status-running"),
        rootNodeId: nodeId,
        activeAttemptId: null,
        status: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
    const page = yield* store.listMcpThreadPage({
      includeSubagents: true,
      statuses: ["running"],
      offset: 0,
      limit: 10,
    });
    assert.equal(page.total, 1);
    assert.deepEqual(
      page.threads.map((thread) => thread.id),
      [threadId],
    );
  }).pipe(Effect.provide(layer)),
);
