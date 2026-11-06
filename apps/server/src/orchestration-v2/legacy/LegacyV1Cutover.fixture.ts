import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import Migration0042 from "../../persistence/Migrations/042_ProjectionThreadLinkedPullRequest.ts";
import Migration0043 from "../../persistence/Migrations/043_ProjectionThreadsUnsettledAt.ts";
import Migration0044 from "../../persistence/Migrations/044_ClearAutomaticProjectModelDefaults.ts";
import Migration0045 from "../../persistence/Migrations/045_ProjectionProjectsAutoPull.ts";
import Migration0046 from "../../persistence/Migrations/046_RepairAutomaticSettlementTimestamps.ts";
import Migration0047 from "../../persistence/Migrations/047_ProjectionProjectIcon.ts";
import Migration0048 from "../../persistence/Migrations/048_ProjectionThreadBranchPullRequest.ts";
import Migration0049 from "../../persistence/Migrations/049_ProjectionThreadsActiveOrderKey.ts";

const PROJECT_ID = "project:cutover";
const ACTIVE_THREAD = "thread:cutover:active";
const ARCHIVED_THREAD = "thread:cutover:archived";
const PINNED_THREAD = "thread:cutover:pinned";
const SNOOZED_THREAD = "thread:cutover:snoozed";
const DELETED_THREAD = "thread:cutover:deleted";
const INTERRUPTED_THREAD = "thread:cutover:interrupted";
const LONG_THREAD = "thread:cutover:long";
const EARLIEST_MARKER = "EARLIEST_IMPORT_MARKER";
const LATEST_MARKER = "LATEST_IMPORT_MARKER";
const modelSelectionJson = '{"instanceId":"codex","model":"gpt-5.4"}';

/** Slot 41 models site-local migrations sharing production ids; the V2 runner applies only ids above the recorded maximum. */
export const seedV1Database = (fixturePath: string, workspace: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA busy_timeout = 5000;`;
      yield* sql`PRAGMA foreign_keys = ON;`;
      yield* sql`PRAGMA journal_mode = WAL;`;
      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (41, 'ThreadSummaryTimeline')
      `;
      yield* sql`
        CREATE TABLE thread_summary_timeline_entries (
          entry_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          payload_json TEXT NOT NULL
        )
      `;
      const tailMigrations = [
        [42, "ProjectionThreadLinkedPullRequest", Migration0042],
        [43, "ProjectionThreadsUnsettledAt", Migration0043],
        [44, "ClearAutomaticProjectModelDefaults", Migration0044],
        [45, "ProjectionProjectsAutoPull", Migration0045],
        [46, "RepairAutomaticSettlementTimestamps", Migration0046],
        [47, "ProjectionProjectIcon", Migration0047],
        [48, "ProjectionThreadBranchPullRequest", Migration0048],
        [49, "ProjectionThreadsActiveOrderKey", Migration0049],
      ] as const;
      for (const [id, name, migration] of tailMigrations) {
        yield* migration;
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (${id}, ${name})
        `;
      }

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          ${PROJECT_ID},
          'Cutover project',
          ${workspace},
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-10T00:00:00.000Z',
          NULL
        )
      `;

      const insertThread = (input: {
        readonly threadId: string;
        readonly title: string;
        readonly createdAt: string;
        readonly updatedAt: string;
        readonly archivedAt?: string;
        readonly snoozedAt?: string;
        readonly snoozedUntil?: string;
        readonly pinnedAt?: string;
        readonly pinOrderKey?: string;
        readonly deletedAt?: string;
        readonly worktreePath?: string;
        readonly linkedPullRequestJson?: string;
      }) =>
        sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, branch, worktree_path, latest_turn_id,
            created_at, updated_at, archived_at, settled_override, settled_at,
            unsettled_at, snoozed_until, snoozed_at, pinned_at, pin_order_key,
            linked_pull_request_json, deleted_at
          ) VALUES (
            ${input.threadId},
            ${PROJECT_ID},
            ${input.title},
            ${modelSelectionJson},
            'full-access',
            'default',
            'main',
            ${input.worktreePath ?? null},
            NULL,
            ${input.createdAt},
            ${input.updatedAt},
            ${input.archivedAt ?? null},
            NULL,
            NULL,
            NULL,
            ${input.snoozedUntil ?? null},
            ${input.snoozedAt ?? null},
            ${input.pinnedAt ?? null},
            ${input.pinOrderKey ?? null},
            ${input.linkedPullRequestJson ?? null},
            ${input.deletedAt ?? null}
          )
        `;

      const insertMessage = (input: {
        readonly messageId: string;
        readonly threadId: string;
        readonly role: "user" | "assistant";
        readonly text: string;
        readonly createdAt: string;
        readonly isStreaming?: boolean;
        readonly attachmentsJson?: string;
      }) =>
        sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, attachments_json,
            is_streaming, created_at, updated_at
          ) VALUES (
            ${input.messageId},
            ${input.threadId},
            NULL,
            ${input.role},
            ${input.text},
            ${input.attachmentsJson ?? "[]"},
            ${input.isStreaming === true ? 1 : 0},
            ${input.createdAt},
            ${input.createdAt}
          )
        `;

      yield* insertThread({
        threadId: ACTIVE_THREAD,
        title: "Active conversation",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-05T00:00:00.000Z",
        linkedPullRequestJson:
          '{"projectId":"project:cutover","repository":"goat-si/goat","number":9100,"url":"https://github.com/goat-si/goat/pull/9100"}',
      });
      yield* insertMessage({
        messageId: "message:cutover:active:1",
        threadId: ACTIVE_THREAD,
        role: "user",
        text: "First question",
        createdAt: "2026-01-01T01:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:active:2",
        threadId: ACTIVE_THREAD,
        role: "assistant",
        text: "First answer",
        createdAt: "2026-01-02T01:00:00.000Z",
        attachmentsJson:
          '[{"type":"image","id":"att-1","name":"shot.png","mimeType":"image/png","sizeBytes":1234}]',
      });
      yield* insertMessage({
        messageId: "message:cutover:active:3",
        threadId: ACTIVE_THREAD,
        role: "user",
        text: "Follow-up question",
        createdAt: "2026-01-03T01:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:active:4",
        threadId: ACTIVE_THREAD,
        role: "assistant",
        text: "Final answer",
        createdAt: "2026-01-05T01:00:00.000Z",
      });

      yield* insertThread({
        threadId: ARCHIVED_THREAD,
        title: "Archived conversation",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-06T00:00:00.000Z",
        archivedAt: "2026-01-06T00:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:archived:1",
        threadId: ARCHIVED_THREAD,
        role: "user",
        text: "Archived question",
        createdAt: "2026-01-01T02:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:archived:2",
        threadId: ARCHIVED_THREAD,
        role: "assistant",
        text: "Archived answer",
        createdAt: "2026-01-02T02:00:00.000Z",
      });

      yield* insertThread({
        threadId: PINNED_THREAD,
        title: "Pinned conversation",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-07T00:00:00.000Z",
        pinnedAt: "2026-01-03T00:00:00.000Z",
        pinOrderKey: "a0",
      });
      yield* insertMessage({
        messageId: "message:cutover:pinned:1",
        threadId: PINNED_THREAD,
        role: "user",
        text: "Pinned question",
        createdAt: "2026-01-01T03:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:pinned:2",
        threadId: PINNED_THREAD,
        role: "assistant",
        text: "Pinned answer",
        createdAt: "2026-01-02T03:00:00.000Z",
      });

      yield* insertThread({
        threadId: SNOOZED_THREAD,
        title: "Snoozed conversation",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-08T00:00:00.000Z",
        snoozedAt: "2026-01-08T00:00:00.000Z",
        snoozedUntil: "2026-02-01T00:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:snoozed:1",
        threadId: SNOOZED_THREAD,
        role: "user",
        text: "Snoozed question",
        createdAt: "2026-01-01T04:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:snoozed:2",
        threadId: SNOOZED_THREAD,
        role: "assistant",
        text: "Snoozed answer part one",
        createdAt: "2026-01-02T04:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:snoozed:3",
        threadId: SNOOZED_THREAD,
        role: "assistant",
        text: "Snoozed answer part two",
        createdAt: "2026-01-03T04:00:00.000Z",
      });

      yield* insertThread({
        threadId: DELETED_THREAD,
        title: "Deleted conversation",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-09T00:00:00.000Z",
        deletedAt: "2026-01-09T00:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:deleted:1",
        threadId: DELETED_THREAD,
        role: "user",
        text: "Deleted question",
        createdAt: "2026-01-01T05:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:deleted:2",
        threadId: DELETED_THREAD,
        role: "assistant",
        text: "Deleted answer",
        createdAt: "2026-01-02T05:00:00.000Z",
      });

      yield* insertThread({
        threadId: INTERRUPTED_THREAD,
        title: "Interrupted conversation",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-09T01:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:interrupted:1",
        threadId: INTERRUPTED_THREAD,
        role: "user",
        text: "Interrupted question",
        createdAt: "2026-01-01T06:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:interrupted:2",
        threadId: INTERRUPTED_THREAD,
        role: "assistant",
        text: "Partial answer",
        createdAt: "2026-01-02T06:00:00.000Z",
        isStreaming: true,
      });

      yield* insertThread({
        threadId: LONG_THREAD,
        title: "Long conversation",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-10T00:00:00.000Z",
        worktreePath: workspace,
      });
      const filler = "history detail ".repeat(800);
      yield* insertMessage({
        messageId: "message:cutover:long:1",
        threadId: LONG_THREAD,
        role: "user",
        text: `${EARLIEST_MARKER} ${filler}`,
        createdAt: "2026-01-01T07:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:long:2",
        threadId: LONG_THREAD,
        role: "assistant",
        text: `${filler} middle answer`,
        createdAt: "2026-01-02T07:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:long:3",
        threadId: LONG_THREAD,
        role: "user",
        text: `${filler} middle question`,
        createdAt: "2026-01-03T07:00:00.000Z",
      });
      yield* insertMessage({
        messageId: "message:cutover:long:4",
        threadId: LONG_THREAD,
        role: "assistant",
        text: `${filler} ${LATEST_MARKER}`,
        createdAt: "2026-01-04T07:00:00.000Z",
      });

      yield* sql`PRAGMA wal_checkpoint(TRUNCATE);`;

      // Deterministic pre-migration snapshot of the legacy recovery tables;
      // post-boot assertions compare preserved column contents, not counts.
      // Migrations may append columns, so the comparison is restricted to the
      // column set recorded here.
      const tableColumns = Effect.fn("seedV1Database.tableColumns")(function* (table: string) {
        const info = yield* sql<{
          readonly name: string;
        }>`SELECT name FROM pragma_table_info(${table})`;
        return info.map((row) => row.name);
      });
      return {
        projects: {
          columns: yield* tableColumns("projection_projects"),
          rows: yield* sql<Record<string, unknown>>`
            SELECT * FROM projection_projects ORDER BY project_id
          `,
        },
        threads: {
          columns: yield* tableColumns("projection_threads"),
          rows: yield* sql<Record<string, unknown>>`
            SELECT * FROM projection_threads ORDER BY thread_id
          `,
        },
        messages: {
          columns: yield* tableColumns("projection_thread_messages"),
          rows: yield* sql<Record<string, unknown>>`
            SELECT * FROM projection_thread_messages ORDER BY message_id
          `,
        },
      };
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: fixturePath }))),
  );
