import { assert, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import Migration070 from "../persistence/Migrations/070_RemoteDispatches.ts";
import Migration101 from "../persistence/Migrations/101_RemoteReportInboxRunId.ts";
import * as Inbox from "./RemoteReportInbox.ts";

const origin = ThreadId.make("origin");

it.effect(
  "folds a lane's progress only while it stays deliverable, and a question ends the run",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migration070;
      yield* Migration101;
      const store = (kind: string, text: string) =>
        Inbox.storeInboxReport(sql, {
          originThreadId: origin,
          correlationId: "rr",
          kind,
          text,
          runId: null,
          createdAt: "2026-10-24T00:00:00.000Z",
        });
      for (const n of [1, 2, 3]) yield* store("progress", `${n}:${"x".repeat(3_000)}`);
      yield* store("needs_input", "4:question");
      yield* store("progress", "5:after");
      const rows = yield* sql<{ kind: string; text: string }>`
      SELECT kind, text FROM remote_report_inbox ORDER BY id`;
      assert.deepEqual(
        rows.map((row) => [row.kind, row.text.split("\n\n").map((part) => part.split(":")[0])]),
        [
          ["progress", ["1", "2"]],
          ["progress", ["3"]],
          ["needs_input", ["4"]],
          ["progress", ["5"]],
        ],
      );
      const inbox = yield* Inbox.RemoteReportInbox;
      const turn = yield* inbox.pending(origin);
      assert.equal(turn.reports.length, rows.length);
    }).pipe(
      Effect.provide(Inbox.layer),
      Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
);
