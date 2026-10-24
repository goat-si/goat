import { assert, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import Migration070 from "../persistence/Migrations/070_RemoteDispatches.ts";
import Migration101 from "../persistence/Migrations/101_RemoteReportInboxRunId.ts";
import * as Inbox from "./RemoteReportInbox.ts";

const origin = ThreadId.make("origin");
const testLayer = Inbox.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const setup = Effect.gen(function* () {
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
  return { sql, store, inbox: yield* Inbox.RemoteReportInbox };
});
// Each report's text starts with its number, so a turn can be checked report by report.
const numbers = (texts: ReadonlyArray<string>) =>
  texts.flatMap((text) => text.split("\n\n").map((part) => part.split(":")[0]));

it.effect(
  "folds a lane's progress only while it stays deliverable, and a question ends the run",
  () =>
    Effect.gen(function* () {
      const { sql, store, inbox } = yield* setup;
      for (const n of [1, 2, 3]) yield* store("progress", `${n}:${"x".repeat(3_000)}`);
      yield* store("needs_input", "4:question");
      yield* store("progress", "5:after");
      const rows = yield* sql<{ kind: string; text: string }>`
        SELECT kind, text FROM remote_report_inbox ORDER BY id`;
      assert.deepEqual(
        rows.map((row) => [row.kind, numbers([row.text])]),
        [
          ["progress", ["1", "2"]],
          ["progress", ["3"]],
          ["needs_input", ["4"]],
          ["progress", ["5"]],
        ],
      );
      assert.equal((yield* inbox.pending(origin)).reports.length, rows.length);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("a report folded while a turn is starting survives that turn's consume", () =>
  Effect.gen(function* () {
    const { store, inbox } = yield* setup;
    yield* store("progress", "1:first");
    const starting = yield* inbox.pending(origin);
    assert.deepEqual(numbers(starting.texts), ["1"]);
    // Arrives after the turn read the inbox and before it consumed what it read.
    yield* store("progress", "2:second");
    yield* inbox.consume(origin, starting.throughId!);
    // The folded row repeats the delivered report rather than losing the new one.
    assert.deepEqual(numbers((yield* inbox.pending(origin)).texts), ["1", "2"]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a backlog larger than one turn drains completely over several turns", () =>
  Effect.gen(function* () {
    const { sql, store, inbox } = yield* setup;
    for (let n = 1; n <= 12; n++) yield* store("progress", `${n}:${"x".repeat(3_000)}`);
    const delivered: Array<string> = [];
    let turns = 0;
    while (true) {
      const turn = yield* inbox.pending(origin);
      if (turn.throughId === null) break;
      delivered.push(...numbers(turn.texts));
      yield* inbox.consume(origin, turn.throughId);
      turns += 1;
    }
    assert.deepEqual(
      delivered,
      Array.from({ length: 12 }, (_, i) => String(i + 1)),
    );
    assert.isAbove(turns, 1);
    assert.lengthOf(yield* sql`SELECT id FROM remote_report_inbox`, 0);
  }).pipe(Effect.provide(testLayer)),
);
