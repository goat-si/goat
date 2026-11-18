import { assert, it } from "@effect/vitest";
import {
  ContextHandoffId,
  EventId,
  ProjectId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "./ProjectionStore.ts";
import { buildBoundedThreadStreamSnapshot } from "./ThreadStream.ts";
import { layerTest, modelSelection, providerInstanceId } from "./ProjectionStore.testkit.ts";

it.effect("SQL snapshot windows leave handoff bodies in SQLite without changing the wire", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:handoff-window");
    yield* store.apply({
      id: EventId.make("event:handoff-window:thread"),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project:handoff-window"),
        title: "Handoff window",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
    const providerThreadId = ProviderThreadId.make("provider-thread:handoff-window");
    const earlierItemId = TurnItemId.make("item:handoff-window:earlier");
    const handoff = (id: string, status: "ready" | "superseded") => ({
      id: ContextHandoffId.make(`handoff:handoff-window:${id}`),
      transferId: null,
      threadId,
      targetRunId: RunId.make("run:handoff-window"),
      fromProviderThreadIds: [providerThreadId],
      toProviderThreadId: providerThreadId,
      coveredRunOrdinals: { from: 1, to: 1 },
      strategy: "full_thread_summary" as const,
      status,
      summaryMessageId: null,
      summaryText: `Summary ${id}`,
      history: {
        messages: [
          {
            role: "user" as const,
            text: "Earlier request ".repeat(1_000),
            threadId,
            runId: null,
            itemId: earlierItemId,
            providerThreadId,
            status: "completed",
            kind: "user_message",
          },
        ],
        coverage: "full",
        omittedItems: 0,
      },
      delivery: { nativeThreadId: "native", status: "injected" as const, itemIds: [earlierItemId] },
      createdByProviderInstanceId: providerInstanceId,
      createdAt: now,
      updatedAt: now,
    });
    // The window keeps a ready handoff and one its rows show; the third is outside it.
    const handoffs = [
      handoff("ready", "ready"),
      handoff("shown", "superseded"),
      handoff("old", "superseded"),
    ];
    for (const payload of handoffs) {
      yield* store.apply({
        id: EventId.make(`event:${payload.id}`),
        type: "context-handoff.updated",
        threadId,
        occurredAt: now,
        payload,
      });
    }
    yield* store.apply({
      id: EventId.make("event:handoff-window:item"),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("item:handoff-window:handoff"),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "handoff",
        contextHandoffId: handoffs[1]!.id,
        fromProviderThreadIds: [providerThreadId],
        toProviderThreadId: providerThreadId,
        fromProviderInstanceIds: [providerInstanceId],
        toProviderInstanceId: providerInstanceId,
        strategy: "full_thread_summary",
      },
    });

    const window = yield* store.getThreadSnapshotWindow(threadId, { rowLimit: 10 });
    const windowHandoffs = window.projection.contextHandoffs;
    assert.deepEqual(
      windowHandoffs.map((row) => row.id),
      [handoffs[0]!.id, handoffs[1]!.id],
    );
    for (const row of windowHandoffs) {
      assert.isUndefined(row.history);
      assert.isUndefined(row.delivery);
    }
    const full = yield* store.getThreadSnapshot(threadId);
    assert.deepEqual(full.projection.contextHandoffs, handoffs);
    assert.deepEqual(
      buildBoundedThreadStreamSnapshot(window),
      buildBoundedThreadStreamSnapshot({
        ...window,
        projection: { ...window.projection, contextHandoffs: handoffs.slice(0, 2) },
      }),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("lists only active subagent IDs without loading shell data", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const createdAt = "2026-01-05T00:00:00.000Z";
    for (const [id, relationship, archivedAt, deletedAt] of [
      ["parent", null, null, null],
      ["active-subagent", "subagent", null, null],
      ["active-subagent-2", "subagent", null, null],
      ["archived-subagent", "subagent", createdAt, null],
      ["deleted-subagent", "subagent", null, createdAt],
    ] as const) {
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, archived_at, deleted_at, payload_json
        ) VALUES (
          ${id}, 'project:test', ${id}, 'codex', 'full-access', 'default',
          ${createdAt}, ${createdAt}, ${archivedAt}, ${deletedAt},
          ${JSON.stringify({ lineage: { relationshipToParent: relationship }, archivedAt })}
        )
      `;
    }

    assert.sameMembers(
      [...(yield* store.listActiveSubagentThreadIds())],
      [ThreadId.make("active-subagent"), ThreadId.make("active-subagent-2")],
    );
    assert.deepEqual(yield* store.listActiveSubagentThreadIds({ limit: 1 }), [
      ThreadId.make("active-subagent"),
    ]);
    assert.deepEqual(
      yield* store.listActiveSubagentThreadIds({
        limit: 1,
        after: ThreadId.make("active-subagent"),
      }),
      [ThreadId.make("active-subagent-2")],
    );
  }).pipe(Effect.provide(layerTest)),
);

// regression: #25621 SQLite rejects statements binding more than 32,766 variables
it.effect("lists every thread in the shell snapshot past SQLite's bound variable limit", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const templateId = ThreadId.make("thread:many:00000");
    yield* store.apply({
      id: EventId.make(`event:${templateId}:created`),
      type: "thread.created",
      threadId: templateId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: templateId,
        projectId: ProjectId.make("project:many"),
        title: "Many",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: templateId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
    const threadCount = 32_767;
    yield* sql`
      CREATE TEMP TABLE many_threads AS
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${threadCount - 1})
      SELECT t.*, n.i AS clone_index FROM orchestration_v2_projection_threads t, n
      WHERE t.thread_id = ${templateId}
    `;
    yield* sql`
      UPDATE many_threads SET
        thread_id = printf('thread:many:%05d', clone_index),
        payload_json = json_set(
          payload_json,
          '$.id', printf('thread:many:%05d', clone_index),
          '$.lineage.rootThreadId', printf('thread:many:%05d', clone_index)
        )
    `;
    yield* sql`ALTER TABLE many_threads DROP COLUMN clone_index`;
    yield* sql`INSERT INTO orchestration_v2_projection_threads SELECT * FROM many_threads`;

    const [unscoped, active] = yield* Effect.all([
      store.getShellSnapshot(),
      store.getShellSnapshot({ location: "active" }),
    ]);
    assert.strictEqual(unscoped.threads.length, threadCount);
    assert.strictEqual(active.threads.length, threadCount);
    assert.strictEqual(yield* store.countThreads(), threadCount);
  }).pipe(Effect.provide(layerTest)),
);
