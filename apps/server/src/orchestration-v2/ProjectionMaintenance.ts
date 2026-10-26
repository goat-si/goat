import {
  ORCHESTRATION_HISTORY_TRIM_FIELD_BYTES,
  ORCHESTRATION_HISTORY_TRIM_IDLE_MS,
  ThreadId,
} from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as EventStore from "./EventStore.ts";
import { trimHistoryItem } from "./historyTrim.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export interface ProjectionVerificationV2 {
  readonly valid: boolean;
  readonly schemaVersion: number;
  readonly expectedSequence: number;
  readonly projectionSequence: number;
  readonly unreadableThreadIds: ReadonlyArray<ThreadId>;
  readonly missingThreadIds: ReadonlyArray<ThreadId>;
  readonly unexpectedThreadIds: ReadonlyArray<ThreadId>;
}

export class ProjectionMaintenanceError extends Schema.TaggedError<ProjectionMaintenanceError>()(
  "ProjectionMaintenanceError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ProjectionMaintenanceV2Shape {
  readonly verify: Effect.Effect<ProjectionVerificationV2, ProjectionMaintenanceError>;
  readonly rebuild: Effect.Effect<ProjectionVerificationV2, ProjectionMaintenanceError>;
  readonly compactEventStore: (betweenPages?: Effect.Effect<void>) => Effect.Effect<
    {
      readonly deletedEventCount: number;
      readonly deletedReceiptCount: number;
      readonly reclaimableBytes: number;
    },
    ProjectionMaintenanceError
  >;
  /**
   * Bounds orchestration history: while it is over budget, trims bulky tool output in threads
   * idle a week, oldest first. Works in fixed pages and yields between them.
   */
  readonly boundHistory: (
    policy: HistoryRetentionPolicy,
  ) => Effect.Effect<HistoryRetentionResult, ProjectionMaintenanceError>;
}

export interface HistoryRetentionPolicy {
  readonly budgetBytes: number;
  readonly now: number;
}

export interface HistoryRetentionResult {
  /** History before the pass: allocated database pages minus memory tables. */
  readonly historyBytes: number;
  readonly trimmedRows: number;
  /** Payload bytes removed. Pages return to the freelist; the file shrinks on vacuum. */
  readonly reclaimedBytes: number;
}

/** Rows one history statement examines; the pass yields to the event loop between pages. */
export const HISTORY_PAGE_ROWS = 64;
/** Second trim tier, used only while history is still over budget after week-idle threads. */
const HISTORY_RECENT_TRIM_IDLE_MS = 86_400_000;

export class ProjectionMaintenanceV2 extends Context.Service<
  ProjectionMaintenanceV2,
  ProjectionMaintenanceV2Shape
>()("goat/orchestration-v2/ProjectionMaintenance/ProjectionMaintenanceV2") {}

type ProjectionMetadataRow = {
  readonly schema_version: number;
  readonly last_sequence: number;
};

const encodeEntityKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.NullOr(Schema.String)])),
);
const decodePayloadObjectOption = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodePayloadObject = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodePayloadObject = (json: string) =>
  Option.getOrUndefined(decodePayloadObjectOption(json));

export const layer: Layer.Layer<
  ProjectionMaintenanceV2,
  never,
  EventStore.EventStoreV2 | ProjectionStore.ProjectionStoreV2 | SqlClient.SqlClient
> = Layer.effect(
  ProjectionMaintenanceV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = yield* EventStore.EventStoreV2;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;

    const verify = Effect.gen(function* () {
      const expectedThreadRows = yield* sql<{ readonly thread_id: string }>`
        SELECT DISTINCT stream_id AS thread_id
        FROM orchestration_events INDEXED BY orchestration_events_v2_created_threads_idx
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND event_type = 'thread.created'
        ORDER BY stream_id ASC
      `;
      const projectionRows = yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id
        FROM orchestration_v2_projection_threads
        ORDER BY thread_id ASC
      `;
      const actualIds = projectionRows.map((row) => ThreadId.make(row.thread_id));
      const expectedIds = expectedThreadRows.map((row) => ThreadId.make(row.thread_id));
      const actualSet = new Set(actualIds);
      const expectedSet = new Set(expectedIds);
      const missingThreadIds = expectedIds.filter((threadId) => !actualSet.has(threadId));
      const unexpectedThreadIds = actualIds.filter((threadId) => !expectedSet.has(threadId));
      const unreadableThreadIds = yield* projectionStore.getUnreadableThreadIds();
      const metadata = yield* sql<ProjectionMetadataRow>`
        SELECT schema_version, last_sequence
        FROM orchestration_v2_projection_metadata
        WHERE projection_name = 'thread-projections'
        LIMIT 1
      `;
      const expectedSequence = yield* eventStore.latestSequence();
      const schemaVersion = metadata[0]?.schema_version ?? 0;
      const projectionSequence = metadata[0]?.last_sequence ?? 0;
      return {
        valid:
          schemaVersion === ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION &&
          projectionSequence === expectedSequence &&
          missingThreadIds.length === 0 &&
          unexpectedThreadIds.length === 0 &&
          unreadableThreadIds.length === 0,
        schemaVersion,
        expectedSequence,
        projectionSequence,
        unreadableThreadIds,
        missingThreadIds,
        unexpectedThreadIds,
      } satisfies ProjectionVerificationV2;
    }).pipe(sql.withTransaction);

    const rebuild = Effect.gen(function* () {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const throughSequence = yield* eventStore.latestSequence();
          yield* sql`DELETE FROM orchestration_v2_projection_context_transfers`;
          yield* sql`DELETE FROM orchestration_v2_projection_context_handoffs`;
          yield* sql`DELETE FROM orchestration_v2_projection_checkpoints`;
          yield* sql`DELETE FROM orchestration_v2_projection_checkpoint_scopes`;
          yield* sql`DELETE FROM orchestration_v2_projection_turn_items`;
          yield* sql`DELETE FROM orchestration_v2_projection_plans`;
          yield* sql`DELETE FROM orchestration_v2_projection_messages`;
          yield* sql`DELETE FROM orchestration_v2_projection_runtime_requests`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_turns`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_threads`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_session_bindings`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_sessions`;
          yield* sql`DELETE FROM orchestration_v2_projection_subagents`;
          yield* sql`DELETE FROM orchestration_v2_projection_nodes`;
          yield* sql`DELETE FROM orchestration_v2_projection_run_attempts`;
          yield* sql`DELETE FROM orchestration_v2_projection_runs`;
          yield* sql`DELETE FROM orchestration_v2_projection_threads`;
          yield* sql`DELETE FROM orchestration_v2_turn_item_positions`;

          const pageSize = 500;
          let lastSequence = 0;
          while (true) {
            const page = yield* eventStore
              .read({ afterSequence: lastSequence, throughSequence, limit: pageSize })
              .pipe(Stream.runCollect);
            for (const stored of page) {
              yield* projectionStore.apply(stored.event);
              if (stored.event.type === "turn-item.updated") {
                yield* sql`
                INSERT INTO orchestration_v2_turn_item_positions (
                  thread_id,
                  turn_item_id,
                  ordinal
                )
                VALUES (
                  ${stored.event.threadId},
                  ${stored.event.payload.id},
                  ${stored.event.payload.ordinal}
                )
                ON CONFLICT(thread_id, turn_item_id) DO UPDATE SET
                  ordinal = excluded.ordinal
                `;
              }
              lastSequence = stored.sequence;
            }
            if (page.length < pageSize) break;
            yield* Effect.yieldNow;
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT INTO orchestration_v2_projection_metadata (
              projection_name,
              schema_version,
              last_sequence,
              updated_at
            )
            VALUES (
              'thread-projections',
              ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION},
              ${lastSequence},
              ${now}
            )
            ON CONFLICT(projection_name) DO UPDATE SET
              schema_version = excluded.schema_version,
              last_sequence = excluded.last_sequence,
              updated_at = excluded.updated_at
          `;
        }),
      );
      return yield* verify;
    });

    const mapError =
      (operation: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.mapError((cause) => new ProjectionMaintenanceError({ operation, cause })),
        );

    // Keep thread.created as the verification and replay anchor; clients recognize deletion by thread.deleted event type.
    const SUPERSEDABLE_THREAD_EVENT_TYPES = [
      "thread.archived",
      "thread.unarchived",
      "thread.settled",
      "thread.unsettled",
      "thread.snoozed",
      "thread.unsnoozed",
      "thread.pinned",
      "thread.auto-settle-set",
      "thread.unpinned",
      "thread.pin-reordered",
      "thread.active-reordered",
      "thread.metadata-updated",
      "thread.pull-request-synced",
      "thread.runtime-mode-updated",
      "thread.interaction-mode-updated",
      "thread.model-selection-updated",
      "thread.provider-switched",
      "thread.guest-share-updated",
    ];
    // Read-state events preserve updatedAt and supersede only each other. Activity events supersede both groups.
    const READ_STATE_THREAD_EVENT_TYPES = ["thread.visited", "thread.marked-unread"];

    const supersedableThreadEventTypes = new Set(SUPERSEDABLE_THREAD_EVENT_TYPES);
    const readStateThreadEventTypes = new Set(READ_STATE_THREAD_EVENT_TYPES);
    // Subagent snapshots stay intact because later rows can reference an earlier prompt.
    // Commanded turn items stay for command-result replay.
    // Small pages bound work on the reader worker and synchronous fallback.
    const COMPACTION_PAGE_SIZE = 50;

    // Keep first/latest keyed events for replay order; page every event to bound sparse scans.
    const compactEventStore = Effect.fn("ProjectionMaintenance.compactEventStore")(function* (
      betweenPages: Effect.Effect<void> = Effect.void,
    ) {
      const bounds = yield* sql<{
        readonly event_sequence: number;
        readonly receipt_row_id: number;
      }>`
        SELECT
          COALESCE((SELECT MAX(sequence) FROM orchestration_events), 0) AS event_sequence,
          COALESCE((SELECT MAX(rowid) FROM orchestration_command_receipts), 0) AS receipt_row_id
      `.pipe(NodeSqliteClient.readOnly);
      let throughSequence = bounds[0]?.event_sequence ?? 0;
      let throughReceiptRowId = bounds[0]?.receipt_row_id ?? 0;
      const retainedThreadIds = new Set<string>();
      const retainedReadStateThreadIds = new Set<string>();
      // Retain each key's oldest candidate, deleting it only when an older event appears.
      const oldestCandidateByEntityKey = new Map<string, number | null>();
      let deletedEventCount = 0;
      let deletedReceiptCount = 0;

      while (throughSequence > 0) {
        const rows = yield* sql<{
          readonly sequence: number;
          readonly application_event_version: number;
          readonly aggregate_kind: string;
          readonly stream_id: string;
          readonly event_type: string;
          readonly entity_id: string | null;
          readonly imported_legacy_thread: number;
        }>`
          SELECT
            event.sequence,
            event.application_event_version,
            event.aggregate_kind,
            event.stream_id,
            event.event_type,
            CASE
              WHEN event.application_event_version = 2
                AND event.event_type IN ('message.updated', 'node.updated')
              THEN json_extract(event.payload_json, '$.id')
              WHEN event.application_event_version = 2
                AND event.event_type = 'turn-item.updated'
                AND event.command_id IS NULL
                AND json_extract(event.payload_json, '$.type') <> 'subagent'
              THEN json_extract(event.payload_json, '$.id')
              WHEN event.application_event_version = 2
                AND event.event_type = 'thread.pull-request-link-updated'
              THEN json_array(json_extract(event.payload_json, '$.host'),
                json_extract(event.payload_json, '$.repository'),
                json_extract(event.payload_json, '$.number'))
              ELSE NULL
            END AS entity_id,
            CASE
              WHEN event.application_event_version = 1 AND event.aggregate_kind = 'thread'
              THEN EXISTS (
                SELECT 1 FROM orchestration_v2_legacy_imports AS legacy_import
                WHERE legacy_import.thread_id = event.stream_id
                  AND legacy_import.transcript_imported_at IS NOT NULL
              )
              ELSE 0
            END AS imported_legacy_thread
          FROM orchestration_events AS event
          WHERE event.sequence <= ${throughSequence}
          ORDER BY event.sequence DESC
          LIMIT ${COMPACTION_PAGE_SIZE + 1}
        `.pipe(NodeSqliteClient.readOnly);
        const page = rows.slice(0, COMPACTION_PAGE_SIZE);
        const obsolete: number[] = [];
        for (const row of page) {
          if (row.imported_legacy_thread === 1) {
            obsolete.push(row.sequence);
          } else if (row.application_event_version === 2) {
            if (
              row.aggregate_kind === "thread" &&
              supersedableThreadEventTypes.has(row.event_type)
            ) {
              if (retainedThreadIds.has(row.stream_id)) obsolete.push(row.sequence);
              else retainedThreadIds.add(row.stream_id);
            } else if (
              row.aggregate_kind === "thread" &&
              readStateThreadEventTypes.has(row.event_type)
            ) {
              if (
                retainedThreadIds.has(row.stream_id) ||
                retainedReadStateThreadIds.has(row.stream_id)
              ) {
                obsolete.push(row.sequence);
              } else retainedReadStateThreadIds.add(row.stream_id);
            } else if (
              row.event_type === "thread.pull-request-link-updated" &&
              retainedThreadIds.has(row.stream_id)
            ) {
              // A newer whole-thread payload already carries this link's state.
              obsolete.push(row.sequence);
            } else if (
              row.event_type === "thread.pull-request-link-updated" ||
              row.event_type === "message.updated" ||
              row.event_type === "node.updated" ||
              (row.event_type === "turn-item.updated" && row.entity_id !== null)
            ) {
              const key = encodeEntityKey([row.event_type, row.stream_id, row.entity_id]);
              const candidate = oldestCandidateByEntityKey.get(key);
              if (candidate === undefined) oldestCandidateByEntityKey.set(key, null);
              else {
                if (candidate !== null) obsolete.push(candidate);
                oldestCandidateByEntityKey.set(key, row.sequence);
              }
            }
          }
        }
        // Never hold a transaction or the reader lock across a yield or a rest.
        yield* Effect.yieldNow;
        if (obsolete.length > 0) {
          yield* sql`DELETE FROM orchestration_events WHERE sequence IN ${sql.in(obsolete)}`;
          deletedEventCount += obsolete.length;
          yield* Effect.yieldNow;
        }
        throughSequence =
          rows.length <= COMPACTION_PAGE_SIZE ? 0 : (page.at(-1)?.sequence ?? 1) - 1;
        if (throughSequence > 0 || throughReceiptRowId > 0) yield* betweenPages;
      }

      while (throughReceiptRowId > 0) {
        const rows = yield* sql<{
          readonly row_id: number;
          readonly command_id: string;
          readonly imported_legacy_thread: number;
        }>`
          SELECT
            receipt.rowid AS row_id,
            receipt.command_id,
            CASE
              WHEN receipt.command_type = 'legacy' AND receipt.aggregate_kind = 'thread'
              THEN EXISTS (
                SELECT 1 FROM orchestration_v2_legacy_imports AS legacy_import
                WHERE legacy_import.thread_id = receipt.aggregate_id
                  AND legacy_import.transcript_imported_at IS NOT NULL
              )
              ELSE 0
            END AS imported_legacy_thread
          FROM orchestration_command_receipts AS receipt
          WHERE receipt.rowid <= ${throughReceiptRowId}
          ORDER BY receipt.rowid DESC
          LIMIT ${COMPACTION_PAGE_SIZE + 1}
        `.pipe(NodeSqliteClient.readOnly);
        const page = rows.slice(0, COMPACTION_PAGE_SIZE);
        const obsolete = page
          .filter((row) => row.imported_legacy_thread === 1)
          .map((row) => row.command_id);
        yield* Effect.yieldNow;
        if (obsolete.length > 0) {
          yield* sql`DELETE FROM orchestration_command_receipts WHERE command_id IN ${sql.in(obsolete)}`;
          deletedReceiptCount += obsolete.length;
          yield* Effect.yieldNow;
        }
        throughReceiptRowId = (page.at(-1)?.row_id ?? 1) - 1;
        if (rows.length <= COMPACTION_PAGE_SIZE) break;
        yield* betweenPages;
      }

      const freelistRows = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
      const pageSizeRows = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
      const reclaimableBytes =
        (freelistRows[0]?.freelist_count ?? 0) * (pageSizeRows[0]?.page_size ?? 0);

      return { deletedEventCount, deletedReceiptCount, reclaimableBytes };
    }, mapError("compact event store"));

    // Memory's own storage sample, refreshed hourly. Measuring here would cost a dbstat walk
    // of the memory tables, and memory is small next to a history budget.
    const memoryBytes = sql<{ readonly bytes: number | null }>`
      SELECT sum(json_extract(current_sample_json, '$.memoryAllocatedBytes')) AS bytes
      FROM memory_compaction_state WHERE space LIKE '\_environment:%' ESCAPE '\'
    `.pipe(
      Effect.map((rows) => rows[0]?.bytes ?? 0),
      Effect.orElseSucceed(() => 0),
    );
    const allocatedBytes = Effect.gen(function* () {
      const pages = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`;
      const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
      const size = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
      return (
        ((pages[0]?.page_count ?? 0) - (free[0]?.freelist_count ?? 0)) * (size[0]?.page_size ?? 0)
      );
    });

    // Event payloads go first: if the pass stops midway, the projection still shows what the
    // next pass has left to do, and it revisits the thread.
    const threadEventPages = Effect.fn("ProjectionMaintenance.threadEventPages")(function* (
      threadId: string,
      visit: (sequences: ReadonlyArray<number>) => Effect.Effect<void, SqlError>,
    ) {
      let after = 0;
      while (true) {
        const page = yield* sql<{ readonly sequence: number }>`
            SELECT sequence FROM orchestration_events
            WHERE application_event_version = 2 AND aggregate_kind = 'thread'
              AND stream_id = ${threadId} AND sequence > ${after}
            ORDER BY sequence LIMIT ${HISTORY_PAGE_ROWS}
          `;
        if (page.length === 0) return;
        yield* visit(page.map((row) => row.sequence));
        yield* Effect.yieldNow;
        if (page.length < HISTORY_PAGE_ROWS) return;
        after = page.at(-1)!.sequence;
      }
    });

    const threadItemPages = Effect.fn("ProjectionMaintenance.threadItemPages")(function* (
      threadId: string,
      visit: (ids: ReadonlyArray<string>) => Effect.Effect<boolean, SqlError>,
    ) {
      let afterOrdinal = Number.MIN_SAFE_INTEGER;
      let afterId = "";
      while (true) {
        const page = yield* sql<{ readonly turn_item_id: string; readonly ordinal: number }>`
            SELECT turn_item_id, ordinal FROM orchestration_v2_projection_turn_items
            WHERE thread_id = ${threadId} AND (ordinal, turn_item_id) > (${afterOrdinal}, ${afterId})
            ORDER BY ordinal, turn_item_id LIMIT ${HISTORY_PAGE_ROWS}
          `;
        if (page.length === 0) return;
        const more = yield* visit(page.map((row) => row.turn_item_id));
        yield* Effect.yieldNow;
        if (!more || page.length < HISTORY_PAGE_ROWS) return;
        afterOrdinal = page.at(-1)!.ordinal;
        afterId = page.at(-1)!.turn_item_id;
      }
    });

    // One row per statement, with a yield after each: a single tool output can be a megabyte,
    // so a page of them read at once would hold the event loop for tens of milliseconds.
    // Untraced: it runs once per page, and trimThread already spans each thread.
    const trimEach = Effect.fn("")(function* <K extends string | number>(
      keys: ReadonlyArray<K>,
      read: (key: K) => Effect.Effect<ReadonlyArray<{ readonly payload_json: string }>, SqlError>,
      write: (key: K, payload: string) => Effect.Effect<unknown, SqlError>,
    ) {
      let saved = 0;
      let trimmed = 0;
      for (const key of keys) {
        const [row] = yield* read(key);
        const item = row === undefined ? undefined : decodePayloadObject(row.payload_json);
        const next = item === undefined ? null : trimHistoryItem(item);
        if (row !== undefined && next !== null) {
          const json = encodePayloadObject(next);
          yield* write(key, json);
          saved += row.payload_json.length - json.length;
          trimmed++;
        }
        yield* Effect.yieldNow;
      }
      return { saved, trimmed };
    });

    const trimThread = Effect.fn("ProjectionMaintenance.trimThread")(function* (
      threadId: string,
      wanted: number,
    ) {
      let saved = 0;
      let trimmed = 0;
      yield* threadEventPages(threadId, (sequences) =>
        Effect.gen(function* () {
          const keys = yield* sql<{ readonly sequence: number }>`
            SELECT sequence FROM orchestration_events
            WHERE sequence IN ${sql.in(sequences)} AND event_type = 'turn-item.updated'
              AND octet_length(payload_json) > ${ORCHESTRATION_HISTORY_TRIM_FIELD_BYTES}
          `;
          const result = yield* trimEach(
            keys.map((row) => row.sequence),
            (sequence) =>
              sql<{
                readonly payload_json: string;
              }>`SELECT payload_json FROM orchestration_events WHERE sequence = ${sequence}`,
            (sequence, payload) =>
              sql`UPDATE orchestration_events SET payload_json = ${payload} WHERE sequence = ${sequence}`,
          );
          saved += result.saved;
          trimmed += result.trimmed;
        }),
      );
      yield* threadItemPages(threadId, (ids) =>
        Effect.gen(function* () {
          const keys = yield* sql<{ readonly turn_item_id: string }>`
            SELECT turn_item_id FROM orchestration_v2_projection_turn_items
            WHERE turn_item_id IN ${sql.in(ids)}
              AND type IN ('command_execution', 'dynamic_tool', 'reasoning')
              AND octet_length(payload_json) > ${ORCHESTRATION_HISTORY_TRIM_FIELD_BYTES}
          `;
          const result = yield* trimEach(
            keys.map((row) => row.turn_item_id),
            (id) =>
              sql<{
                readonly payload_json: string;
              }>`SELECT payload_json FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${id}`,
            (id, payload) =>
              sql`UPDATE orchestration_v2_projection_turn_items SET payload_json = ${payload} WHERE turn_item_id = ${id}`,
          );
          saved += result.saved;
          trimmed += result.trimmed;
          return saved < wanted;
        }),
      );
      return { saved, trimmed };
    });

    // Oldest first; visit returns false to stop the walk. With settled set, threads with a run
    // still queued or under way are skipped: their output may still be read back.
    const idleThreads = Effect.fn("ProjectionMaintenance.idleThreads")(function* (
      idleBeforeMs: number,
      visit: (threadId: string) => Effect.Effect<boolean, SqlError>,
      settled = false,
    ) {
      const idleBefore = DateTime.formatIso(DateTime.makeUnsafe(idleBeforeMs));
      let afterAt = "";
      let afterId = "";
      while (true) {
        const page = yield* sql<{ readonly thread_id: string; readonly updated_at: string }>`
            SELECT thread_id, updated_at FROM orchestration_v2_projection_threads AS thread
            WHERE updated_at < ${idleBefore} AND (updated_at, thread_id) > (${afterAt}, ${afterId})
              ${
                settled
                  ? sql`AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs AS run
                WHERE run.thread_id = thread.thread_id
                  AND run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting'))`
                  : sql``
              }
            ORDER BY updated_at, thread_id LIMIT ${HISTORY_PAGE_ROWS}
          `;
        for (const row of page) if (!(yield* visit(row.thread_id))) return;
        if (page.length < HISTORY_PAGE_ROWS) return;
        afterAt = page.at(-1)!.updated_at;
        afterId = page.at(-1)!.thread_id;
      }
    });

    const boundHistory = Effect.fn("ProjectionMaintenance.boundHistory")(function* (
      policy: HistoryRetentionPolicy,
    ) {
      const memory = yield* memoryBytes;
      const historyBytes = Effect.map(allocatedBytes, (bytes) => Math.max(0, bytes - memory));
      const before = yield* historyBytes;
      let reclaimedBytes = 0;
      let trimmedRows = 0;
      // Payload bytes overstate the pages a trim frees, so the walk re-measures after each thread.
      let current = before;
      const trimUntilWithinBudget = Effect.fn("ProjectionMaintenance.trimUntilWithinBudget")(
        function* (threadId: string) {
          const { saved, trimmed } = yield* trimThread(threadId, current - policy.budgetBytes);
          reclaimedBytes += saved;
          trimmedRows += trimmed;
          if (trimmed > 0) current = yield* historyBytes;
          return current > policy.budgetBytes;
        },
      );
      if (current > policy.budgetBytes)
        yield* idleThreads(policy.now - ORCHESTRATION_HISTORY_TRIM_IDLE_MS, trimUntilWithinBudget);
      // A host that works every day has no week-idle threads, so history grew without bound
      // (3.5 GB in ten days). Settled threads idle for a day are next, still oldest first.
      if (current > policy.budgetBytes)
        yield* idleThreads(policy.now - HISTORY_RECENT_TRIM_IDLE_MS, trimUntilWithinBudget, true);
      return { historyBytes: before, trimmedRows, reclaimedBytes };
    });

    return ProjectionMaintenanceV2.of({
      verify: mapError("verify")(verify),
      rebuild: mapError("rebuild")(rebuild),
      compactEventStore,
      boundHistory: (policy) => mapError("bound history")(boundHistory(policy)),
    });
  }),
);
