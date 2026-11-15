import { assert, it } from "@effect/vitest";
import {
  EventId,
  type OrchestrationV2ThreadHistoryPage,
  ProjectId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "./ProjectionStore.ts";
import {
  driver,
  encodeUnknownJsonString,
  layerTest,
  modelSelection,
  providerInstanceId,
  traceSqlStatements,
} from "./ProjectionStore.testkit.ts";
import {
  buildBoundedThreadProjection,
  encodeThreadHistoryCursor,
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
} from "./threadHistoryPaging.ts";

it.layer(layerTest)("ProjectionStoreV2", (it) => {
  it.effect("pages a whole thread without re-reading its full timeline for every page", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:paged-scrollback");
      const runId = RunId.make("run:paged-scrollback");
      const itemCount = 600;
      yield* projectionStore.apply({
        id: EventId.make("event:paged-scrollback:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:paged-scrollback"),
          title: "Paged scrollback",
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
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_thread_id, status,
          requested_at, completed_at, payload_json
        ) VALUES (
          ${runId}, ${threadId}, 1, 'codex', NULL, 'completed', ${nowIso}, ${nowIso},
          ${encodeUnknownJsonString({
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: "message:paged-scrollback",
            rootNodeId: "node:paged-scrollback",
            activeAttemptId: null,
            status: "completed",
            requestedAt: nowIso,
            startedAt: nowIso,
            completedAt: nowIso,
            checkpointId: null,
            contextHandoffId: null,
          })}
        )
      `;
      for (let ordinal = 0; ordinal < itemCount; ordinal += 1) {
        const id = `turn-item:paged-scrollback:${ordinal}`;
        const message = ordinal % 9 === 0;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${threadId}, ${runId}, NULL, NULL, NULL, NULL, ${ordinal},
            ${message ? "user_message" : "command_execution"}, 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: `item ${ordinal}`,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              ...(message
                ? {
                    type: "user_message",
                    createdBy: "user",
                    creationSource: "web",
                    messageId: `message:paged-scrollback:${ordinal}`,
                    inputIntent: "turn_start",
                    text: `Turn ${ordinal}`,
                    attachments: [],
                  }
                : { type: "command_execution", input: "echo", output: "ok", exitCode: 0 }),
            })}
          )
        `;
      }
      // An unbounded read of every turn item in the thread costs O(thread) per page, so a full
      // scrollback that repeats it on each page is quadratic in thread length.
      const wholeThreadReads = (statements: ReadonlyArray<string>) =>
        statements.filter(
          (statement) =>
            /FROM orchestration_v2_projection_turn_items(\s+AS item)?\s+WHERE (item\.)?thread_id = \?\s*(ORDER BY|$)/.test(
              statement,
            ) && !/\bLIMIT\b/.test(statement),
        ).length;
      const snapshot = yield* projectionStore.getThreadSnapshot(threadId);

      const history = traceSqlStatements();
      let cursor: string | null = encodeThreadHistoryCursor({
        snapshotSequence: snapshot.snapshotSequence,
        sourceThreadId: threadId,
        sourceItemId: "absent",
        position: itemCount,
      });
      const historyIds: Array<string> = [];
      let historyPages = 0;
      while (cursor !== null) {
        const page: OrchestrationV2ThreadHistoryPage = yield* projectionStore
          .getThreadHistoryPage(threadId, cursor)
          .pipe(Effect.withTracer(history.tracer));
        historyIds.push(...page.items.map((row) => String(row.sourceItemId)));
        historyPages += 1;
        cursor = page.hasMoreHistory ? page.nextCursor : null;
      }
      assert.strictEqual(new Set(historyIds).size, itemCount);
      assert.isAtLeast(historyPages, 4);

      const timeline = traceSqlStatements();
      const timelineIds: Array<string> = [];
      let afterPosition = -1;
      let timelinePages = 0;
      for (let hasMore = true; hasMore;) {
        const page = yield* projectionStore
          .getTimelinePage(threadId, { view: "activity", afterPosition, limit: 100 })
          .pipe(Effect.withTracer(timeline.tracer));
        timelineIds.push(...page.items.map((row) => String(row.sourceItemId)));
        afterPosition = page.items.at(-1)?.position ?? afterPosition;
        timelinePages += 1;
        hasMore = page.hasMore;
      }
      assert.strictEqual(new Set(timelineIds).size, itemCount);
      assert.isAtLeast(timelinePages, 4);

      assert.isAtMost(
        wholeThreadReads(history.statements),
        1,
        `getThreadHistoryPage read the whole thread on each of ${historyPages} pages`,
      );
      assert.isAtMost(
        wholeThreadReads(timeline.statements),
        1,
        `getTimelinePage read the whole thread on each of ${timelinePages} pages`,
      );

      // A write to the thread a fork inherits from must reach the fork's next page.
      const forkThreadId = ThreadId.make("thread:paged-scrollback:fork");
      yield* projectionStore.apply({
        id: EventId.make("event:paged-scrollback:fork"),
        type: "thread.created",
        threadId: forkThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: forkThreadId,
          projectId: ProjectId.make("project:paged-scrollback"),
          title: "Paged scrollback fork",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: threadId,
            relationshipToParent: "fork",
            rootThreadId: threadId,
          },
          forkedFrom: { type: "run", threadId, runId },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      const forkPage = () =>
        projectionStore.getTimelinePage(forkThreadId, { view: "activity", limit: 1 });
      const forkTotal = (yield* forkPage()).totalItems;
      assert.strictEqual((yield* forkPage()).totalItems, forkTotal);
      yield* projectionStore.apply({
        id: EventId.make("event:paged-scrollback:late-item"),
        type: "turn-item.updated",
        threadId,
        runId,
        driver,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("turn-item:paged-scrollback:late"),
          threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: itemCount,
          status: "completed",
          title: "late",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "command_execution",
          input: "echo",
        },
      });
      assert.strictEqual((yield* forkPage()).totalItems, forkTotal + 1);

      // Another store instance's write reaches this one only through the committed thread event.
      const directId = "turn-item:paged-scrollback:direct";
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${directId}, ${threadId}, ${runId}, NULL, NULL, NULL, NULL, ${itemCount + 1},
          'command_execution', 'completed', ${nowIso},
          ${encodeUnknownJsonString({
            id: directId,
            threadId,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: itemCount + 1,
            status: "completed",
            title: "direct",
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "command_execution",
            input: "echo",
          })}
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          'event:paged-scrollback:direct', 'thread', ${threadId}, 1,
          'turn-item.updated', ${nowIso}, 'user', '{}', '{}', 2
        )
      `;
      assert.strictEqual((yield* forkPage()).totalItems, forkTotal + 2);

      // An agent started this thread, so the snapshot folds no work. Its cursor then names a
      // command that an older page folds into the run's one work group.
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET type = CASE WHEN ordinal = 0 THEN type ELSE 'assistant_message' END,
          payload_json = CASE
            WHEN ordinal = 0 THEN json_set(payload_json, '$.createdBy', 'agent')
            ELSE json_set(payload_json, '$.type', 'assistant_message',
              '$.messageId', turn_item_id, '$.streaming', json('false'))
          END
        WHERE thread_id = ${threadId} AND type = 'user_message'
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          'event:paged-scrollback:agent-started', 'thread', ${threadId}, 2,
          'turn-item.updated', ${nowIso}, 'user', '{}', '{}', 2
        )
      `;
      const window = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
        userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
        deferWork: true,
      });
      const bounded = buildBoundedThreadProjection({
        projection: window.projection,
        snapshotSequence: window.snapshotSequence,
      });
      const loaded = [bounded.projection.visibleTurnItems];
      let earlier = bounded.hasMoreHistory ? bounded.historyCursor : null;
      while (earlier !== null) {
        assert.isBelow(loaded.length, 20);
        const page: OrchestrationV2ThreadHistoryPage = yield* projectionStore.getThreadHistoryPage(
          threadId,
          earlier,
          undefined,
          false,
          "deferred",
        );
        loaded.unshift(page.items);
        earlier = page.hasMoreHistory ? page.nextCursor : null;
      }
      const held = loaded.flat();
      const heldOrdinals = held.map((row) => row.item.ordinal);
      assert.deepEqual(
        heldOrdinals,
        [...new Set(heldOrdinals)].toSorted((left, right) => left - right),
      );
      const folded = held.find((row) => row.item.deferredWork !== undefined)?.item;
      assert.isAbove(folded?.deferredWork?.itemCount ?? 0, 150);
      const everyRow = yield* projectionStore.getTimelinePage(threadId, {
        view: "activity",
        limit: itemCount + 2,
      });
      // Every row is on the client, or is work that the folded row stands for.
      assert.deepEqual(
        everyRow.items
          .filter(
            ({ item }) =>
              !heldOrdinals.includes(item.ordinal) &&
              !(
                item.type === "command_execution" &&
                folded?.deferredWork !== undefined &&
                item.ordinal > folded.ordinal &&
                item.ordinal <= folded.deferredWork.lastOrdinal
              ),
          )
          .map(({ item }) => item.ordinal),
        [],
      );
    }),
  );
});
