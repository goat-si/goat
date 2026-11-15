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
import * as Tracer from "effect/Tracer";
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

  it.effect("a page read from a window equals the page read from the full index", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      // Seeded, so every run builds the same threads.
      let seed = 0x5eed;
      const random = () => {
        seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
        return seed / 2 ** 32;
      };
      const chance = (probability: number) => random() < probability;
      const spans: Array<string> = [];
      const tracer = Tracer.make({
        span(options) {
          spans.push(options.name);
          return new Tracer.NativeSpan(options);
        },
      });
      let windowReads = 0;
      let foldedGroups = 0;

      for (let round = 0; round < 5; round += 1) {
        const threadId = ThreadId.make(`thread:window-equivalence:${round}`);
        const created = {
          id: EventId.make(`event:window-equivalence:${round}`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:window-equivalence"),
            title: "Window equivalence",
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
        } satisfies Parameters<typeof projectionStore.apply>[0];
        yield* projectionStore.apply(created);
        // The last thread puts three things below a window: a user turn under a hidden queued
        // turn, the start of a long run that folds, and the start of the run before it, which
        // has later rows among the first rows of the long run.
        const windowEdges = round === 4;
        // One run of each kind in a random order, then an active run. Every other thread has
        // one user turn and then only wake turns.
        // The fourth thread is a turn, many rolled-back rows, a late notification of that turn,
        // then 149 one-row turns. A page stops at that notification only if it counts as a turn.
        const kinds =
          round === 3
            ? ["rolled back", "late wake", ...Array.from({ length: 149 }, () => "one row")]
            : windowEdges
              ? ["short", "cancelled queued turn", "folds work", "long fold", "stopped"]
              : [
                  "rolled back",
                  "cancelled queued turn",
                  "replaced attempt",
                  "stopped",
                  "stopped",
                  "folds work",
                  "folds work",
                  "short",
                  "short",
                  "short",
                ]
                  .map((kind) => ({ kind, order: random() }))
                  .toSorted((left, right) => left.order - right.order)
                  .map(({ kind }) => kind);
        const agentDriven = round === 1;
        const runs: Array<unknown> = [];
        const attempts: Array<unknown> = [];
        const items: Array<unknown> = [];
        const tiedWithHidden: Array<TurnItemId> = [];
        const pageEnds: Array<string> = [];
        let ordinal = 0;
        for (const [index, kind] of [...kinds, "active"].entries()) {
          const run = index + 1;
          const runId = `run:window-equivalence:${round}:${run}`;
          const nodeId = `node:window-equivalence:${round}:${run}`;
          const status =
            kind === "active"
              ? "running"
              : kind === "rolled back"
                ? "rolled_back"
                : kind === "cancelled queued turn"
                  ? "cancelled"
                  : kind === "short" && chance(0.5)
                    ? "interrupted"
                    : "completed";
          runs.push({
            id: runId,
            threadId,
            ordinal: run,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: `message:window-equivalence:${round}:${run}`,
            rootNodeId: nodeId,
            activeAttemptId: null,
            status,
            requestedAt: nowIso,
            startedAt: nowIso,
            completedAt: nowIso,
            checkpointId: null,
            contextHandoffId: null,
          });
          attempts.push({
            id: `attempt:window-equivalence:${round}:${run}`,
            runId,
            attemptOrdinal: 1,
            rootNodeId: nodeId,
            providerInstanceId,
            providerThreadId: "provider-thread:window-equivalence",
            providerTurnId: null,
            reason: "initial",
            status: kind === "replaced attempt" || chance(0.2) ? "superseded" : "completed",
            startedAt: nowIso,
            completedAt: nowIso,
          });
          // The first row after a rolled-back run shares the ordinal of that run's last row.
          let tie = kinds[index - 1] === "rolled back";
          if (tie)
            tiedWithHidden.push(
              TurnItemId.make(`turn-item:window-equivalence:${round}:${items.length}`),
            );
          const add = (type: string, fields: Record<string, unknown> = {}) => {
            if (ordinal === 0 || !(tie || chance(0.04))) ordinal += 1;
            tie = false;
            items.push({
              id: `turn-item:window-equivalence:${round}:${items.length}`,
              threadId,
              runId,
              nodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: null,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type,
              ...fields,
            });
          };
          const userMessage = (inputIntent: string) =>
            add("user_message", {
              createdBy: "user",
              creationSource: "web",
              messageId: `message:window-equivalence:${round}:${items.length}`,
              inputIntent,
              text: "Turn",
              attachments: [],
            });
          const notification = () =>
            add("notification", {
              source: { kind: "system" },
              outcome: "completed",
              summary: "Wake",
            });
          const wakes =
            kind === "one row"
              ? run % 10 !== 0
              : windowEdges
                ? ["folds work", "long fold", "stopped"].includes(kind)
                : kind !== "late wake" && (agentDriven ? run > 1 : chance(0.2));
          if (round === 3 && kind === "active")
            pageEnds.push(`turn-item:window-equivalence:${round}:${items.length}`);
          if (wakes) notification();
          else userMessage(kind === "cancelled queued turn" ? "queued_turn" : "turn_start");
          // A stopped run never folds, so it is long enough for page ends to fall inside it.
          const work =
            kind === "late wake"
              ? 420 + Math.floor(random() * 40)
              : kind === "stopped"
                ? 320 + Math.floor(random() * 60)
                : kind === "folds work"
                  ? 155 + Math.floor(random() * 60)
                  : kind === "long fold"
                    ? 300
                    : kind === "one row"
                      ? 0
                      : Math.floor(random() * 30);
          for (let row = 0; row < work; row += 1) {
            // The first rows of a long fold and the work of a late wake belong to the run before.
            const owner =
              (kind === "long fold" && row < 140) || kind === "late wake"
                ? {
                    runId: `run:window-equivalence:${round}:${run - 1}`,
                    nodeId: `node:window-equivalence:${round}:${run - 1}`,
                  }
                : {};
            if (chance(0.5))
              add("command_execution", { input: "echo", output: "ok", exitCode: 0, ...owner });
            else add("reasoning", { text: "", streaming: false, ...owner });
            // A reply deep in a stopped run: a page that ends on it has enough work below it
            // to fold, and only the stop request above it says that it does not.
            const reply = kind === "stopped" && row === 200;
            if (reply) pageEnds.push(`turn-item:window-equivalence:${round}:${items.length}`);
            // With these replies, the part of a long fold in one window is too small to fold,
            // and a shown row lies below the notification of a late wake.
            const replies = kind === "long fold" || kind === "late wake";
            if (reply || (replies && row % 5 === 0) || chance(0.02))
              add("assistant_message", {
                messageId: `message:window-equivalence:${round}:${items.length}`,
                text: "Reply",
                streaming: false,
              });
            // A late wake has no other input above its turn start.
            if (chance(0.01) && kind !== "late wake") notification();
            if (chance(0.004) && !agentDriven && !windowEdges && kind !== "late wake")
              userMessage("steer");
          }
          if (kind === "late wake") notification();
          if (kind === "stopped") add("run_interrupt_request", { message: "Stop" });
          if (kind === "replaced attempt" || (kind === "stopped" && chance(0.5)))
            add("run_interrupt_result", { message: "Stopped" });
          if (kind === "short" && chance(0.3))
            add("error", {
              status: "failed",
              failure: { class: "unknown", message: "Failed", code: null, retryable: false },
            });
        }
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id, status,
            requested_at, completed_at, payload_json
          )
          SELECT json_extract(value, '$.id'), ${threadId}, json_extract(value, '$.ordinal'), 'codex',
            NULL, json_extract(value, '$.status'), ${nowIso}, ${nowIso}, value
          FROM json_each(${encodeUnknownJsonString(runs)})`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_run_attempts (
            attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider,
            provider_instance_id, provider_thread_id, provider_turn_id, status, payload_json
          )
          SELECT json_extract(value, '$.id'), ${threadId}, json_extract(value, '$.runId'), 1,
            json_extract(value, '$.rootNodeId'), ${providerInstanceId}, ${providerInstanceId},
            json_extract(value, '$.providerThreadId'), NULL, json_extract(value, '$.status'), value
          FROM json_each(${encodeUnknownJsonString(attempts)})`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          )
          SELECT json_extract(value, '$.id'), ${threadId}, json_extract(value, '$.runId'),
            json_extract(value, '$.nodeId'), NULL, NULL, NULL, json_extract(value, '$.ordinal'),
            json_extract(value, '$.type'), json_extract(value, '$.status'), ${nowIso}, value
          FROM json_each(${encodeUnknownJsonString(items)})`;

        // Applying an event drops the thread's cached index, as each event of a run does, so
        // each of these reads a window.
        const requests: Array<{
          readonly read: Effect.Effect<unknown, ProjectionStore.ProjectionStoreV2Error>;
          readonly page: unknown;
        }> = [];
        const windowed = <A>(read: Effect.Effect<A, ProjectionStore.ProjectionStoreV2Error>) =>
          Effect.gen(function* () {
            yield* projectionStore.apply(created);
            spans.length = 0;
            const page = yield* read.pipe(Effect.withTracer(tracer));
            if (spans.includes("ProjectionStore.readTimelineWindow")) windowReads += 1;
            requests.push({ read, page });
            return page;
          });
        const history = (
          cursor: string,
          throughEntryId?: string,
          conversationOnly?: boolean,
          workMode?: "deferred" | "work",
        ) =>
          projectionStore.getThreadHistoryPage(
            threadId,
            cursor,
            throughEntryId,
            conversationOnly,
            workMode,
          );
        const timeline = (options: ProjectionStore.ProjectionTimelinePageOptions) =>
          projectionStore.getTimelinePage(threadId, options);

        const { totalItems } = yield* windowed(timeline({ limit: 0 }));
        const newest = (yield* windowed(
          timeline({ view: "activity", afterPosition: totalItems - 2, limit: 1 }),
        )).items[0]!;
        const firstCursor = encodeThreadHistoryCursor({
          snapshotSequence: 0,
          sourceThreadId: threadId,
          sourceItemId: newest.sourceItemId,
          position: newest.position,
        });
        const groups = new Map<string, string>();
        for (const [conversationOnly, workMode] of [
          [false, "deferred"],
          [false, undefined],
          [true, undefined],
        ] as const) {
          for (let cursor: string | null = firstCursor; cursor !== null;) {
            const page: OrchestrationV2ThreadHistoryPage = yield* windowed(
              history(cursor, undefined, conversationOnly, workMode),
            );
            for (const { item } of page.items)
              if (item.deferredWork !== undefined) groups.set(item.id, item.deferredWork.cursor);
            cursor = page.nextCursor;
          }
        }
        for (const sourceItemId of pageEnds) {
          const cursor = encodeThreadHistoryCursor({
            snapshotSequence: 0,
            sourceThreadId: threadId,
            sourceItemId,
            position: 0,
          });
          yield* windowed(history(cursor, undefined, false, "deferred"));
        }
        foldedGroups += groups.size;
        for (const [anchorId, groupCursor] of groups) {
          for (let cursor: string | null = groupCursor; cursor !== null;)
            cursor = (yield* windowed(history(cursor, anchorId, false, "work"))).nextCursor;
        }
        for (const view of ["messages", "activity"] as const) {
          for (const afterPosition of [-1, Math.floor(totalItems / 3), totalItems - 5])
            yield* windowed(timeline({ view, afterPosition, limit: 20 }));
          for (const beforePosition of [
            Number.POSITIVE_INFINITY,
            Math.floor(totalItems / 3),
            totalItems - 5,
          ])
            yield* windowed(timeline({ view, beforePosition, limit: 20 }));
          yield* windowed(timeline({ view, afterPosition: 3, beforePosition: 40, limit: 20 }));
          // GOAT's tail read is a backward page that ends after the newest item.
          yield* windowed(timeline({ view, tail: true, limit: 20 }));
        }
        for (const itemId of [newest.sourceItemId, ...tiedWithHidden])
          yield* windowed(timeline({ itemId, limit: 1 }));

        // An attachment lookup and a jump to an entry read the full index and leave it cached,
        // so the same requests now come from it.
        yield* timeline({ attachmentId: "absent", limit: 1 });
        yield* history(firstCursor, "absent", false, "deferred");
        spans.length = 0;
        for (const { read, page } of requests)
          assert.deepEqual(yield* read.pipe(Effect.withTracer(tracer)), page);
        assert.notInclude(spans, "ProjectionStore.readTimelineWindow");
      }
      assert.isAtLeast(foldedGroups, 2);
      assert.isAbove(windowReads, 60);
    }),
  );
});
