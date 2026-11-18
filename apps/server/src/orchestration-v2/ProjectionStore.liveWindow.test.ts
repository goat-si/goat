import { assert, it } from "@effect/vitest";
import { EventId, ProjectId, ThreadId, TurnItemId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "./ProjectionStore.ts";
import {
  encodeUnknownJsonString,
  layerTest,
  modelSelection,
  providerInstanceId,
} from "./ProjectionStore.testkit.ts";
import {
  buildBoundedThreadProjection,
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
} from "./threadHistoryPaging.ts";

it.layer(layerTest)("ProjectionStoreV2 live-run window", (it) => {
  it.effect("a deferred window of a running turn holds the same rows as the full read", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      // Seeded, so every run builds the same threads.
      let seed = 0x11fe;
      const random = () => {
        seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
        return seed / 2 ** 32;
      };
      // Live turns shorter and longer than a turn page; the third shares its run id with
      // another thread's rows, which must not count toward the window.
      for (const [round, liveRows] of [120, 480, 900, 1600].entries()) {
        const threadId = ThreadId.make(`thread:live-window:${round}`);
        yield* projectionStore.apply({
          id: EventId.make(`event:live-window:${round}`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:live-window"),
            title: "Live window",
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
        const runs: Array<unknown> = [];
        const items: Array<{
          readonly id: string;
          readonly runId: string;
          readonly ordinal: number;
        }> = [];
        let ordinal = 0;
        const runCount = 3;
        for (let run = 1; run <= runCount; run += 1) {
          const live = run === runCount;
          const runId = `run:live-window:${round}:${run}`;
          const nodeId = `node:live-window:${round}:${run}`;
          runs.push({
            id: runId,
            threadId,
            ordinal: run,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: `message:live-window:${round}:${run}`,
            rootNodeId: nodeId,
            activeAttemptId: null,
            status: live ? "running" : "completed",
            requestedAt: nowIso,
            startedAt: nowIso,
            completedAt: live ? null : nowIso,
            checkpointId: null,
            contextHandoffId: null,
          });
          const add = (type: string, fields: Record<string, unknown> = {}) => {
            ordinal += 1;
            items.push({
              id: `turn-item:live-window:${round}:${items.length}`,
              threadId,
              runId,
              nodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: live ? "running" : "completed",
              title: null,
              startedAt: nowIso,
              completedAt: live ? null : nowIso,
              updatedAt: nowIso,
              type,
              ...fields,
            } as never);
          };
          add("user_message", {
            createdBy: "user",
            creationSource: "web",
            messageId: `message:live-window:${round}:${items.length}`,
            inputIntent: "turn_start",
            text: "Turn",
            attachments: [],
          });
          const work = live ? liveRows : 20 + Math.floor(random() * 40);
          for (let row = 0; row < work; row += 1) {
            if (random() < 0.5)
              add("command_execution", { input: "echo", output: "ok", exitCode: 0 });
            else add("reasoning", { text: "", streaming: false });
            if (random() < 0.04)
              add("assistant_message", {
                messageId: `message:live-window:${round}:${items.length}`,
                text: "Reply",
                streaming: false,
              });
          }
        }
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id, status,
            requested_at, completed_at, payload_json
          )
          SELECT json_extract(value, '$.id'), ${threadId}, json_extract(value, '$.ordinal'), 'codex',
            NULL, json_extract(value, '$.status'), ${nowIso}, NULL, value
          FROM json_each(${encodeUnknownJsonString(runs)})`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          )
          SELECT json_extract(value, '$.id'), ${threadId}, json_extract(value, '$.runId'),
            json_extract(value, '$.nodeId'), NULL, NULL, NULL, json_extract(value, '$.ordinal'),
            json_extract(value, '$.type'), json_extract(value, '$.status'), ${nowIso}, value
          FROM json_each(${encodeUnknownJsonString(items)})`;
        const liveRunId = `run:live-window:${round}:${runCount}`;
        if (round === 2)
          yield* sql`
            INSERT INTO orchestration_v2_projection_turn_items (
              turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
              parent_item_id, ordinal, type, status, updated_at, payload_json
            )
            SELECT turn_item_id || ':foreign', 'thread:live-window:foreign', run_id, NULL, NULL,
              NULL, NULL, ordinal + 5000, type, status, updated_at, payload_json
            FROM orchestration_v2_projection_turn_items WHERE run_id = ${liveRunId}`;

        const full = (yield* projectionStore.getThreadSnapshot(threadId)).projection
          .visibleTurnItems;
        const liveIds = items.filter((item) => item.runId === liveRunId).map((item) => item.id);
        const ids = (rows: ReadonlyArray<{ readonly sourceItemId: string }>) =>
          rows.map((row) => row.sourceItemId);
        const windowRows = (anchorItemId?: TurnItemId) =>
          projectionStore
            .getThreadSnapshotWindow(threadId, {
              rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
              userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
              deferWork: true,
              ...(anchorItemId === undefined ? {} : { anchorItemId }),
            })
            .pipe(Effect.map((window) => window.projection.visibleTurnItems));
        const window = yield* windowRows();
        // A running run folds nothing.
        assert.isTrue(window.every((row) => row.item.deferredWork === undefined));
        if (liveIds.length > THREAD_HISTORY_PAGE_POLICY.maxTurnItems) {
          // A long running turn pages from inside itself: the newest rows of the full read.
          assert.deepEqual(ids(window), ids(full.slice(-THREAD_HISTORY_SNAPSHOT_ROW_LIMIT)));
          // From an anchor that is still more than a turn page into the running turn.
          const anchorAt =
            full.findIndex((row) => row.sourceItemId === liveIds[0]) +
            THREAD_HISTORY_PAGE_POLICY.maxTurnItems +
            100;
          const anchor = TurnItemId.make(full[anchorAt]!.sourceItemId);
          assert.deepEqual(
            ids(yield* windowRows(anchor)),
            ids(full.slice(anchorAt + 1 - THREAD_HISTORY_SNAPSHOT_ROW_LIMIT, anchorAt + 1)),
          );
        } else {
          // A short running turn is whole, every row of it as the full read has it.
          assert.deepEqual(
            ids(window).filter((id) => liveIds.includes(id)),
            ids(full).filter((id) => liveIds.includes(id)),
          );
        }
      }
    }),
  );
  it.effect("a held queued run after a stop does not count toward the newest turn's length", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      // A stopped run whose newest turn holds exactly a turn page of conversation rows, and a
      // longer one; behind each, a held queued run whose only row is its undelivered input.
      for (const turnRows of [THREAD_HISTORY_PAGE_POLICY.maxTurnItems, 600]) {
        const threadId = ThreadId.make(`thread:held-tail:${turnRows}`);
        yield* projectionStore.apply({
          id: EventId.make(`event:held-tail:${turnRows}`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:held-tail"),
            title: "Held tail",
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
        const stoppedRunId = `run:held-tail:${turnRows}:stopped`;
        const heldRunId = `run:held-tail:${turnRows}:held`;
        const run = (id: string, ordinal: number, status: "interrupted" | "queued") => ({
          id,
          threadId,
          ordinal,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: `message:${id}`,
          rootNodeId: `node:${id}`,
          activeAttemptId: null,
          status,
          requestedAt: nowIso,
          startedAt: status === "queued" ? null : nowIso,
          completedAt: status === "queued" ? null : nowIso,
          checkpointId: null,
          contextHandoffId: null,
        });
        const item = (
          runId: string,
          ordinal: number,
          type: "user_message" | "assistant_message",
          fields: Record<string, unknown>,
        ) => ({
          id: `turn-item:held-tail:${turnRows}:${ordinal}`,
          threadId,
          runId,
          nodeId: `node:${runId}`,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal,
          status: runId === heldRunId ? "pending" : "completed",
          title: null,
          startedAt: nowIso,
          completedAt: runId === heldRunId ? null : nowIso,
          updatedAt: nowIso,
          type,
          ...fields,
        });
        const userMessage = (inputIntent: string, ordinal: number) => ({
          createdBy: "user",
          creationSource: "web",
          messageId: `message:held-tail:${turnRows}:${ordinal}`,
          inputIntent,
          text: "Turn",
          attachments: [],
        });
        const items = [
          item(stoppedRunId, 1, "user_message", userMessage("turn_start", 1)),
          ...Array.from({ length: turnRows - 1 }, (_, index) =>
            item(stoppedRunId, index + 2, "assistant_message", {
              messageId: `message:held-tail:${turnRows}:${index + 2}`,
              text: "Reply",
              streaming: false,
            }),
          ),
          item(heldRunId, turnRows + 1, "user_message", userMessage("queued_turn", turnRows + 1)),
        ];
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id, status,
            requested_at, completed_at, payload_json
          )
          SELECT json_extract(value, '$.id'), ${threadId}, json_extract(value, '$.ordinal'), 'codex',
            NULL, json_extract(value, '$.status'), ${nowIso}, NULL, value
          FROM json_each(${encodeUnknownJsonString([
            run(stoppedRunId, 1, "interrupted"),
            run(heldRunId, 2, "queued"),
          ])})`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          )
          SELECT json_extract(value, '$.id'), ${threadId}, json_extract(value, '$.runId'),
            json_extract(value, '$.nodeId'), NULL, NULL, NULL, json_extract(value, '$.ordinal'),
            json_extract(value, '$.type'), json_extract(value, '$.status'), ${nowIso}, value
          FROM json_each(${encodeUnknownJsonString(items)})`;

        const full = yield* projectionStore.getThreadSnapshot(threadId);
        const window = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
          userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
          deferWork: true,
        });
        const ids = (rows: ReadonlyArray<{ readonly sourceItemId: string }>) =>
          rows.map((row) => row.sourceItemId);
        const bounded = (snapshot: typeof full) =>
          ids(buildBoundedThreadProjection(snapshot).projection.visibleTurnItems);
        // The held input stays hidden in both reads.
        assert.notInclude(ids(full.projection.visibleTurnItems), items.at(-1)!.id);
        // A turn of exactly a turn page is whole in both; a longer one pages from inside itself
        // with the newest rows of the full read.
        assert.deepEqual(bounded(window), bounded(full), String(turnRows));
        if (turnRows > THREAD_HISTORY_PAGE_POLICY.maxTurnItems) {
          assert.deepEqual(
            ids(window.projection.visibleTurnItems),
            ids(full.projection.visibleTurnItems.slice(-THREAD_HISTORY_SNAPSHOT_ROW_LIMIT)),
          );
        }
      }
    }),
  );
});
