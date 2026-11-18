import { assert } from "@effect/vitest";
import {
  ChannelDeliveryId,
  ChannelInputId,
  ChannelTaskId,
  type ChannelOutboundMessage,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as SqlClient from "effect/sql/SqlClient";
import { SqlError } from "effect/sql/SqlError";
import * as TestClock from "effect/testing/TestClock";
import * as BotThreads from "../ChannelBotThreads.ts";
import * as ChannelDeliveryWorker from "../ChannelDeliveryWorker.ts";
import * as Ledger from "../ChannelLedger.ts";
import * as ChannelRuntime from "../ChannelRuntime.ts";
import * as Views from "../channelTaskViews.ts";
import { timelineIdsFor } from "../channelIds.ts";
import { messageMarkKey } from "../channelTaskMessageMarks.ts";
import { commitTransition } from "../channelTaskWrites.ts";
import { LedgerCallHolds } from "./dispatchRace.ts";
import { botThreadId, environmentId, makeHarness, owner, ownerId } from "./ChannelHarness.ts";
import { at, insertTask, setup } from "./botThreadHistory.fixture.ts";

/** Shared fixture for the GOAT Bot unread tests: real ledger, delivery worker and GOAT transport. */
export const taskId = ChannelTaskId.make("task:unread");
export const otherId = ChannelTaskId.make("task:other");
const destination = { kind: "goat", environmentId, threadId: botThreadId } as const;
export const message = (id: string, forTask = taskId): ChannelOutboundMessage => ({
  deliveryId: ChannelDeliveryId.make(id),
  destination,
  kind: "result",
  text: id,
  taskId: forTask,
});
export const now = Effect.map(DateTime.now, DateTime.formatIso);
/** A task as reception leaves it: its input's receipt already went out, so its messages may follow. */
export const task = (id: string) =>
  Effect.gen(function* () {
    yield* insertTask(id, { status: "running", createdAt: at(1) });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT OR IGNORE INTO channel_outbox (delivery_id, cause_key, input_id, kind,
      destination_kind, message_json, state, next_attempt_at, created_at, updated_at)
      VALUES ('receipt:input:1', 'reply:input:1', 'input:1', 'receipt', 'goat', '{}', 'delivered',
      ${at(1)}, ${at(1)}, ${at(1)})`;
  });
/** Queues messages the way every producer does: through the ledger's outbox insert. */
export const queue = (...items: ReadonlyArray<ChannelOutboundMessage>) =>
  Effect.gen(function* () {
    yield* (yield* Ledger.ChannelLedger).enqueueDeliveries(
      items.map((item) => ({
        deliveryId: item.deliveryId,
        causeKey: "test:" + item.deliveryId,
        ...(item.taskId === undefined ? {} : { taskId: item.taskId }),
        message: item,
      })),
      yield* now,
    );
  });
export const ownerToken = Effect.gen(function* () {
  const runtime = yield* ChannelRuntime.ChannelRuntime;
  assert.isTrue(yield* runtime.claimForWork);
  return runtime.ownerToken;
});
/** The real delivery worker hands GOAT rows to the real GOAT transport; receipts settle first. */
export const deliverDue = Effect.gen(function* () {
  const token = yield* ownerToken;
  const worker = yield* ChannelDeliveryWorker.ChannelDeliveryWorker;
  yield* worker.deliverDue(token);
  yield* worker.settleReceipts;
  yield* worker.deliverDue(token);
});
export const deliver = (...items: ReadonlyArray<ChannelOutboundMessage>) =>
  Effect.andThen(queue(...items), deliverDue);
/** A task write one second later, as a status change, a follow-up or a bot step would make. */
/** The stored task, which every fixture step expects to exist. */
const storedTask = (id: ChannelTaskId = taskId) =>
  Effect.gen(function* () {
    const stored = yield* (yield* Ledger.ChannelLedger).getTask(id);
    if (stored === undefined) return yield* Effect.die("missing task " + id);
    return stored;
  });
export const statusUpdate = (id = taskId) =>
  Effect.gen(function* () {
    yield* TestClock.adjust("1 second");
    const ledger = yield* Ledger.ChannelLedger;
    const changed = yield* commitTransition(ledger, yield* storedTask(id), {
      type: "task.worker.bound",
      payload: { worker: { environmentId, threadId: botThreadId, generation: 1 } },
    });
    assert.isDefined(changed);
  });
export const followUp = (key: string) =>
  Effect.gen(function* () {
    yield* TestClock.adjust("1 second");
    const ledger = yield* Ledger.ChannelLedger;
    const changed = yield* commitTransition(ledger, yield* storedTask(), {
      type: "task.followup.received",
      payload: { inputId: ChannelInputId.make(key), text: "more", from: "Owner", generation: 1 },
    });
    assert.isDefined(changed);
  });
export const rows = Effect.gen(function* () {
  const result = yield* (yield* BotThreads.ChannelBotThreads).list(owner);
  return result.rows.flatMap((item) => (item.kind === "task" ? [item] : []));
});
export const row = (id = taskId) =>
  Effect.gen(function* () {
    const found = (yield* rows).find((item) => item.task.taskId === id);
    if (found === undefined) return yield* Effect.die("no row for " + id);
    return found;
  });
export const acknowledge = (readThrough: string) =>
  Effect.gen(function* () {
    yield* (yield* Views.ChannelTaskViews).update({ taskId, readThrough }, owner);
  });
/** A task whose first message the person has read. */
export const ready = Effect.gen(function* () {
  yield* setup;
  yield* task(taskId);
  yield* statusUpdate();
  yield* deliver(message("initial"));
  yield* acknowledge((yield* row()).lastActivityAt);
  assert.isFalse((yield* row()).unread);
});
const sqlRows = <A extends object>(
  run: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, SqlError>,
) => Effect.flatMap(SqlClient.SqlClient, run);
export const markOf = sqlRows(
  (sql) =>
    sql<{ readonly value_json: string }>`SELECT value_json FROM channel_runtime_state
    WHERE key = ${messageMarkKey(ownerId, taskId)}`,
);
export const outboxState = (id: string) =>
  Effect.map(
    sqlRows(
      (sql) =>
        sql<{ readonly state: string }>`SELECT state FROM channel_outbox WHERE delivery_id = ${id}`,
    ),
    (found) => found[0]?.state,
  );
/** Commands the GOAT transport committed for a delivery: one per message it ever recorded. */
export const recordsOf = (id: string) =>
  Effect.map(
    sqlRows(
      (sql) =>
        sql<{ readonly n: number }>`SELECT count(*) AS n FROM orchestration_command_receipts
        WHERE command_id = ${timelineIdsFor(botThreadId, "delivery:" + id, "send").commandId}`,
    ),
    (found) => found[0]?.n ?? 0,
  );
export const refuseMarks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TRIGGER refuse_mark_insert BEFORE INSERT ON channel_runtime_state
    WHEN NEW.key LIKE 'task-message-mark:%' BEGIN SELECT RAISE(ABORT, 'mark refused'); END`;
  yield* sql`CREATE TRIGGER refuse_mark_update BEFORE UPDATE ON channel_runtime_state
    WHEN NEW.key LIKE 'task-message-mark:%' BEGIN SELECT RAISE(ABORT, 'mark refused'); END`;
});
export const allowMarks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TRIGGER refuse_mark_insert`;
  yield* sql`DROP TRIGGER refuse_mark_update`;
});
export const updatedAt = (id = taskId) =>
  Effect.gen(function* () {
    return (yield* storedTask(id)).task.updatedAt;
  });
export const warnings = () => {
  const logs: string[] = [];
  const layer = Logger.layer(
    [
      Logger.make(({ message: logged, logLevel }) => {
        if (logLevel === "Warn") logs.push(JSON.stringify(logged));
      }),
    ],
    { mergeWithExisting: false },
  );
  return { logs, layer };
};
export const withHolds = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      BotThreads.layer.pipe(
        Layer.provideMerge(Views.layer),
        Layer.provideMerge(Layer.provideMerge(LedgerCallHolds.layer, makeHarness().layer)),
      ),
    ),
  );
