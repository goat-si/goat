import { assert, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { makeComputerUseHistory } from "./ComputerUseHistory.ts";
import { recordAdmittedCall } from "./ComputerUseHistoryAdmission.ts";

it.effect("does not persist typed secrets supplied in desktop target metadata", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const history = yield* makeComputerUseHistory;
    const threadId = ThreadId.make("thread:private");
    yield* recordAdmittedCall(
      history,
      threadId,
      {
        action: "reserve",
        controlId: "control:private",
        connectionId: "connection:private",
        callId: "1",
        interruptions: 0,
        idleEpoch: 0,
        name: "type_text",
        args: {
          text: "private-secret",
          target: { role: "textbox", name: "private-secret", title: "private-secret" },
        },
      },
      { reservationId: "ticket:private" },
    );
    const rows = yield* history.listForThread(threadId);
    assert.lengthOf(rows, 1);
    assert.equal(rows[0]?.targetLabel, "textbox");
    assert.equal(rows[0]?.typedLength, 14);
    assert.isNull(rows[0]?.typedText);
    assert.notInclude(JSON.stringify(rows), "private-secret");
    const sql = yield* SqlClient.SqlClient;
    assert.notInclude(
      JSON.stringify(yield* sql`SELECT * FROM computer_use_input_history`),
      "private-secret",
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
