import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import { makeComputerUseHistory } from "../cua/ComputerUseHistory.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { recordBrowserAction } from "./ComputerUseHistoryBrowser.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("browser history", (it) => {
  it.effect("stores the tab host without its URL path, credentials or query", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const history = yield* makeComputerUseHistory;
      yield* recordBrowserAction(history, {
        threadId: "thread:a",
        url: "https://user:password@example.test/private?token=secret#fragment",
        action: "click",
        verdict: "sent",
      });
      yield* recordBrowserAction(history, {
        threadId: "thread:a",
        url: "https://app.example/secret",
        action: "type",
        verdict: "sent",
        typedText: "secret",
      });
      const entries = yield* history.listForThread("thread:a");
      assert.equal(entries[0]?.typedLength, 6);
      assert.isNull(entries[0]?.typedText);
      const entry = entries[1];
      assert.equal(entry?.tabHost, "example.test");
      assert.equal(entry?.method, "click");
      assert.deepEqual(yield* history.listForThread("thread:b"), []);
    }),
  );
});
