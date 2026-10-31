import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Clock from "effect/Clock";
import { runMigrations } from "../persistence/Migrations.ts";
import { makeComputerUseHistory } from "./ComputerUseHistory.ts";
import { historyStamp, initializeHistorySequence } from "./ComputerUseHistoryStamp.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("computer use history", (it) => {
  it.effect("records outcomes per thread with safe typed text", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const history = yield* makeComputerUseHistory;
      const base = {
        threadId: "thread:a",
        target: { kind: "app", id: "fixture.app", name: "Fixture" },
        method: "type_text",
        targetLabel: "textbox",
        verdict: "sent",
      } as const;
      yield* history.record({ ...base, typed: { value: "hello", field: "normal", keep: false } });
      yield* history.record({
        ...base,
        verdict: "refused",
        refusalCode: "expired",
        typed: { value: "hello", field: "normal", keep: true },
      });
      yield* history.record({ ...base, typed: { value: "secret", field: "secure", keep: true } });
      yield* history.record({ ...base, threadId: "thread:b" });
      const entries = yield* history.listForThread("thread:a");
      assert.equal(entries.length, 3);
      assert.deepEqual(
        entries.map((entry) => [
          entry.verdict,
          entry.refusalCode,
          entry.typedLength,
          entry.typedText,
        ]),
        [
          ["sent", null, 6, null],
          ["refused", "expired", 5, "hello"],
          ["sent", null, 5, null],
        ],
      );
      assert.equal(entries[0]?.appId, "fixture.app");
      assert.equal(entries[0]?.appName, "Fixture");
      assert.equal(entries[0]?.targetLabel, "textbox");
    }),
  );
  it.effect("records a redacted length even when the proxy does not send text", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const history = yield* makeComputerUseHistory;
      yield* history.record({
        threadId: "thread:a",
        target: { kind: "app" },
        method: "type_text",
        verdict: "sent",
        typed: { length: 6, field: "unknown", keep: true },
      });
      const entries = yield* history.listForThread("thread:a");
      assert.equal(entries[0]?.typedLength, 6);
      assert.isNull(entries[0]?.typedText);
    }),
  );
  it.effect("pages equal-time entries newest first within one thread", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const history = yield* makeComputerUseHistory;
      const base = {
        threadId: "thread:paging",
        target: { kind: "tab", host: "example.test" },
        verdict: "sent",
      } as const;
      yield* history.record({ ...base, method: "first" });
      yield* history.record({ ...base, method: "second" });
      yield* history.record({ ...base, threadId: "thread:other-paging", method: "other" });
      yield* history.record({ ...base, method: "third" });
      const first = yield* history.listForThread("thread:paging", { limit: 2 });
      assert.deepEqual(
        first.map((entry) => entry.method),
        ["third", "second"],
      );
      const last = first[1];
      if (last === undefined) return assert.fail("missing cursor");
      const second = yield* history.listForThread("thread:paging", {
        limit: 2,
        before: { recordedAt: last.recordedAt, id: last.id },
      });
      assert.deepEqual(
        second.map((entry) => entry.method),
        ["first"],
      );
    }),
  );
  it.effect("orders desktop settlement by completion when timestamps tie", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const history = yield* makeComputerUseHistory;
      const now = yield* Clock.currentTimeMillis;
      const admission = historyStamp(now);
      const click = historyStamp(now);
      const settlement = historyStamp(now);
      yield* history.record({
        threadId: "thread:desktop-order",
        target: { kind: "app" },
        method: "desktop",
        verdict: "unknown_outcome",
        stamp: admission,
        reservation: { id: "ticket:desktop-order", controlId: "control:desktop-order" },
      });
      yield* history.record({
        threadId: "thread:desktop-order",
        target: { kind: "tab", host: "example.test" },
        method: "browser",
        verdict: "sent",
        stamp: click,
      });
      assert.isTrue(
        yield* history.settle({
          threadId: "thread:desktop-order",
          controlId: "control:desktop-order",
          reservationId: "ticket:desktop-order",
          verdict: "sent",
          stamp: settlement,
        }),
      );
      assert.deepEqual(
        (yield* history.listForThread("thread:desktop-order")).map((row) => row.method),
        ["desktop", "browser"],
      );
    }),
  );
  it.effect("keeps equal-time completion order after a server restart", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      const now = yield* Clock.currentTimeMillis;
      const previous = historyStamp(now);
      yield* sql`INSERT INTO computer_use_input_history
        (thread_id, recorded_at, order_seq, target_kind, method, verdict)
        VALUES ('thread:restart-order', ${now}, ${previous.orderSeq + 100}, 'app', 'before-restart', 'sent')`;
      yield* initializeHistorySequence();
      const history = yield* makeComputerUseHistory;
      yield* history.record({
        threadId: "thread:restart-order",
        target: { kind: "app" },
        method: "after-restart",
        verdict: "sent",
        stamp: historyStamp(now),
      });
      assert.deepEqual(
        (yield* history.listForThread("thread:restart-order")).map((row) => row.method),
        ["after-restart", "before-restart"],
      );
    }),
  );
  it.effect("prunes entries older than 30 days without deleting newer entries", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const history = yield* makeComputerUseHistory;
      const entry = {
        threadId: "thread:a",
        target: { kind: "tab", host: "example.test" },
        method: "click",
        verdict: "sent",
      } as const;
      yield* history.record(entry);
      yield* TestClock.adjust("31 days");
      assert.equal((yield* history.listForThread("thread:a")).length, 0);
      yield* history.record(entry);
      const sql = yield* SqlClient.SqlClient;
      const stored = yield* sql<{
        count: number;
      }>`SELECT count(*) AS count FROM computer_use_input_history`;
      assert.equal(stored[0]?.count, 1);
      const entries = yield* history.listForThread("thread:a");
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.tabHost, "example.test");
    }),
  );
});
