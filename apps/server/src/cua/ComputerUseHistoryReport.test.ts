import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import { runMigrations } from "../persistence/Migrations.ts";
import { makeComputerUseHistory } from "./ComputerUseHistory.ts";
import { recordCallOutcome } from "./ComputerUseHistoryReport.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("proxy history reports", (it) => {
  it.effect("records only the authenticated thread and redacts secure or disabled text", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const history = yield* makeComputerUseHistory;
      const report = {
        type: "callOutcome",
        controlId: "control:a",
        tool: "type_text",
        app: { id: "fixture.app", name: "Fixture" },
        verdict: "sent",
        typed: { length: 6, text: "secret", fieldKind: "normal" },
      } as const;
      yield* recordCallOutcome(history, "thread:a", report, false);
      yield* recordCallOutcome(history, "thread:a", report, true);
      yield* recordCallOutcome(
        history,
        "thread:a",
        { ...report, typed: { ...report.typed, fieldKind: "unknown" } },
        true,
      );
      const entries = yield* history.listForThread("thread:a");
      assert.deepEqual(
        entries.map((entry) => entry.typedText),
        [null, "secret", null],
      );
      assert.deepEqual(
        entries.map((entry) => entry.typedLength),
        [6, 6, 6],
      );
      assert.deepEqual(yield* history.listForThread("thread:b"), []);
      const { app: _app, ...unresolved } = report;
      yield* recordCallOutcome(history, "thread:a", unresolved, false);
      assert.equal((yield* history.listForThread("thread:a"))[0]?.appName, "Unknown app");
    }),
  );
});
