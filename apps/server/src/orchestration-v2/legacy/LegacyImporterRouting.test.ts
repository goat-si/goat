import { assert, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { layerReaderDatabase, traceSqlRouting } from "../../persistence/testkit/SqliteRouting.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as LegacyV1ThreadImporter from "./LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
const layerDatabase = layerReaderDatabase;
const layerEventStoreProvided = EventStore.layer.pipe(Layer.provideMerge(layerDatabase));
const layerProjectionStoreProvided = ProjectionStore.layer.pipe(Layer.provideMerge(layerDatabase));
const layerStoresProvided = Layer.mergeAll(
  layerDatabase,
  layerEventStoreProvided,
  layerProjectionStoreProvided,
);
const layerEventSinkProvided = EventSink.layer.pipe(Layer.provide(layerStoresProvided));
const layerImporterProvided = LegacyV1ThreadImporter.layer.pipe(
  Layer.provide(Layer.mergeAll(layerStoresProvided, layerEventSinkProvided)),
);

const layerTest = Layer.mergeAll(
  layerStoresProvided,
  layerEventSinkProvided,
  layerImporterProvided,
);
const seedPendingTranscripts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
  const threadIds = [ThreadId.make("thread:first"), ThreadId.make("thread:later")];
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at
    ) VALUES (
      'project:background', 'Legacy project', '/tmp/legacy-background', '[]',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    )
  `;
  for (const threadId of threadIds) {
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        interaction_mode, created_at, updated_at
      ) VALUES (
        ${threadId}, 'project:background', 'Legacy thread',
        '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      )
    `;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, role, text, is_streaming, created_at, updated_at
      ) VALUES
        (${`${threadId}:old`}, ${threadId}, 'user', 'Old question', 0,
          '2026-01-01T01:00:00.000Z', '2026-01-01T01:00:00.000Z'),
        (${`${threadId}:latest`}, ${threadId}, 'user', 'Latest question', 0,
          '2026-01-02T01:00:00.000Z', '2026-01-02T01:00:00.000Z')
    `;
  }
  yield* importer.reconcileShells;
});

it.effect("routes shell selectors to readers while imports stay writable", () =>
  Effect.gen(function* () {
    const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const sql = yield* SqlClient.SqlClient;
    const { queries, trace } = traceSqlRouting();
    yield* seedPendingTranscripts.pipe(trace);
    const selectors = queries.filter(
      ({ query }) =>
        query.includes("FROM projection_threads AS thread") ||
        query.includes("FROM orchestration_v2_legacy_imports AS legacy_import") ||
        query.includes("FROM projection_thread_messages AS message"),
    );
    assert.lengthOf(selectors, 6);
    assert.deepEqual([...new Set(selectors.map((row) => row.connection))], ["reader"]);
    assert.deepEqual(yield* importer.reconcileShells, {
      importedThreadCount: 0,
      importedMessageCount: 0,
    });
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at
        ) VALUES (
          'thread:uncommitted', 'project:background', 'Uncommitted legacy title',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, role, text, is_streaming, created_at, updated_at
          ) VALUES (
            'message:uncommitted', 'thread:uncommitted', 'user', 'Uncommitted preview', 0,
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
          )
        `;
        yield* sql`
          UPDATE orchestration_v2_projection_threads
          SET payload_json = json_remove(payload_json, '$.pinnedAt')
          WHERE thread_id = 'thread:first'
        `;
        yield* sql`
          UPDATE projection_threads SET pinned_at = '2026-01-01T00:00:00.000Z'
          WHERE thread_id = 'thread:first'
        `;
        const result = yield* importer.reconcileShells;
        assert.deepEqual(result, { importedThreadCount: 2, importedMessageCount: 1 });
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const repaired = yield* projections.getThreadProjection(ThreadId.make("thread:first"));
        assert.equal(DateTime.formatIso(repaired.thread.pinnedAt!), "2026-01-01T00:00:00.000Z");
        const imported = yield* projections.getThreadProjection(
          ThreadId.make("thread:uncommitted"),
        );
        assert.equal(imported.messages[0]?.text, "Uncommitted preview");
        assert.equal(
          (yield* projections.getThreadProjection(ThreadId.make("thread:uncommitted"))).thread
            .title,
          "Uncommitted legacy title",
        );
      }),
    );
  }).pipe(Effect.provide(layerTest)),
);
