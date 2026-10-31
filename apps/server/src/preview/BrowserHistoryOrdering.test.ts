import { assert, it } from "@effect/vitest";
import type { PreviewAutomationActionEvent } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import { makeComputerUseHistory } from "../cua/ComputerUseHistory.ts";
import { awaitHistory } from "../cua/ComputerUseHistoryBackground.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import {
  browserHistoryPrefix,
  makeBrowserHistoryRecordAction,
} from "./BrowserHistoryRecordAction.ts";
import { recordBrowserAction } from "./ComputerUseHistoryBrowser.ts";

it.effect("orders by action completion even when earlier retention evidence arrives last", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* runMigrations();
      const history = yield* makeComputerUseHistory;
      const completedAt = yield* Clock.currentTimeMillis;
      const owner = yield* Effect.scope;
      const requests = yield* Queue.unbounded<{
        effect: ReturnType<typeof recordBrowserAction>;
        resolve: () => void;
        reject: (cause: unknown) => void;
      }>();
      yield* Queue.take(requests).pipe(
        Effect.flatMap(({ effect, resolve, reject }) =>
          effect.pipe(Effect.match({ onFailure: reject, onSuccess: resolve }), Effect.forkScoped),
        ),
        Effect.forever,
        Effect.forkScoped,
      );
      const run = (effect: ReturnType<typeof recordBrowserAction>) =>
        new Promise<void>((resolve, reject) => {
          Queue.offerUnsafe(requests, { effect, resolve, reject });
        });
      const launches: Array<Promise<void>> = [];
      const record = makeBrowserHistoryRecordAction(
        history,
        (effect) => {
          launches.push(run(effect));
        },
        owner,
        () => completedAt,
      );
      const actionTimeline: Array<PreviewAutomationActionEvent> = [];
      const tab = {
        threadId: "thread:ordering",
        page: { url: () => "https://example.test" },
        actionTimeline,
        diagnostics: { firstLine: (cause: unknown) => String(cause) },
      };
      const evidence = Promise.withResolvers<boolean>();
      yield* Effect.promise(() =>
        record(tab, "type", async () => "typed", {
          typedText: "hello",
          finishRetention: () => evidence.promise,
        }),
      );
      yield* Effect.promise(() => record(tab, "click", async () => "clicked"));
      yield* Effect.promise(async () => {
        await Promise.all(launches);
      });
      const first = tab.actionTimeline[0];
      const second = tab.actionTimeline[1];
      if (first === undefined || second === undefined) return assert.fail("missing action events");
      yield* awaitHistory(browserHistoryPrefix(tab.threadId) + second.id);
      assert.deepEqual(
        (yield* history.listForThread(tab.threadId)).map((row) => row.method),
        ["click"],
      );
      evidence.resolve(false);
      yield* awaitHistory(browserHistoryPrefix(tab.threadId) + first.id);
      assert.deepEqual(
        (yield* history.listForThread(tab.threadId)).map((row) => row.method),
        ["click", "type"],
      );
      const newest = yield* history.listForThread(tab.threadId, { limit: 1 });
      const cursor = newest[0];
      if (cursor === undefined) return assert.fail("missing cursor");
      assert.equal(cursor.recordedAt, completedAt);
      const older = yield* history.listForThread(tab.threadId, {
        limit: 1,
        before: { recordedAt: cursor.recordedAt, id: cursor.id, orderSeq: cursor.orderSeq },
      });
      assert.deepEqual(
        older.map((row) => row.method),
        ["type"],
      );
      const legacy = yield* history.listForThread(tab.threadId, {
        limit: 1,
        before: { recordedAt: cursor.recordedAt, id: cursor.id },
      });
      assert.deepEqual(
        legacy.map((row) => row.method),
        ["type"],
      );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM computer_use_input_history WHERE id = ${cursor.id}`;
      const afterDeletion = yield* history.listForThread(tab.threadId, {
        limit: 1,
        before: { recordedAt: cursor.recordedAt, id: cursor.id, orderSeq: cursor.orderSeq },
      });
      assert.deepEqual(
        afterDeletion.map((row) => row.method),
        ["type"],
      );
    }),
  ).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
