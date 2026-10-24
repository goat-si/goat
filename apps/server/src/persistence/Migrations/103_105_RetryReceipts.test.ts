import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import RemoteReportReceipts from "./103_RemoteReportReceipts.ts";
import PendingAttachmentUploads from "./104_PendingAttachmentUploads.ts";
import ScheduledTaskWebhookSecretRef from "./105_ScheduledTaskWebhookSecretRef.ts";

const columns = (table: string) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) => sql<{ readonly name: string }>`SELECT name FROM pragma_table_info(${table})`,
    ),
    Effect.map((rows) => rows.map((row) => row.name)),
  );

it.effect("a fresh database gets the receipt, pending upload and secretRef storage", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    assert.includeMembers(yield* columns("remote_report_receipts"), [
      "thread_id",
      "client_request_id",
      "args_digest",
      "wake_command_id",
      "delivered_at",
    ]);
    assert.includeMembers(yield* columns("mcp_pending_uploads"), ["attachment_id", "owner"]);
    assert.include(yield* columns("scheduled_tasks"), "webhook_secret_ref");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "a database at 102 upgrades with its reports and tasks intact, and the steps run again",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 102 });
      yield* sql`INSERT INTO remote_report_inbox (origin_thread_id, correlation_id, kind, text, run_id, created_at)
      VALUES ('launcher', 'local:lane', 'progress', 'Halfway.', NULL, '2026-10-25T00:00:00.000Z')`;
      const before = yield* columns("scheduled_tasks");
      assert.notInclude(before, "webhook_secret_ref");
      assert.deepStrictEqual(
        (yield* runMigrations()).map(([id]) => id),
        [103, 104, 105, 106],
      );
      const inbox = yield* sql<{ readonly text: string }>`SELECT text FROM remote_report_inbox`;
      assert.deepStrictEqual(
        inbox.map((row) => row.text),
        ["Halfway."],
      );
      // A relocated migration id runs a step again over its own table or column.
      yield* RemoteReportReceipts;
      yield* PendingAttachmentUploads;
      yield* ScheduledTaskWebhookSecretRef;
      assert.strictEqual(
        (yield* columns("scheduled_tasks")).filter((name) => name === "webhook_secret_ref").length,
        1,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
