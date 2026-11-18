import { assert, describe, it } from "@effect/vitest";
import { ChannelTaskId, type ChannelOutboundMessage } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as BotThreads from "./ChannelBotThreads.ts";
import * as ChannelDeliveryWorker from "./ChannelDeliveryWorker.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as Ledger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as Views from "./channelTaskViews.ts";
import { timelineIdsFor } from "./channelIds.ts";
import { TASK_CHANGES_COALESCE } from "./channelTaskChanges.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import { LedgerCallHolds } from "./testkit/dispatchRace.ts";
import { watchTaskChanges } from "./testkit/taskChanges.ts";
import {
  botThreadId,
  goatInput,
  makeHarness,
  owner,
  rpcContext,
} from "./testkit/ChannelHarness.ts";
import { provide, setup } from "./testkit/botThreadHistory.fixture.ts";

import {
  taskId,
  message,
  now,
  task,
  queue,
  ownerToken,
  deliverDue,
  deliver,
  row,
  ready,
  markOf,
  outboxState,
  recordsOf,
  refuseMarks,
  allowMarks,
  warnings,
  withHolds,
} from "./testkit/botThreadUnread.fixture.ts";

describe("task unread survives delivery failures", () => {
  it.effect(
    "regression #2550: a message that never reaches the bot thread leaves the row read, unmoved and without a mark",
    () =>
      provide(
        Effect.gen(function* () {
          yield* ready;
          const before = yield* row();
          const mark = yield* markOf;
          const sql = yield* SqlClient.SqlClient;
          const doomed = timelineIdsFor(botThreadId, "delivery:doomed-message", "send").commandId;
          // Trigger bodies take no bound parameters; the command id is a plain generated id.
          yield* sql.unsafe(
            `CREATE TRIGGER refuse_doomed BEFORE INSERT ON orchestration_command_receipts
            WHEN NEW.command_id = '${doomed}' BEGIN SELECT RAISE(ABORT, 'timeline refused'); END`,
          );
          yield* queue(message("doomed-message"));
          for (let attempt = 0; attempt < 10; attempt++) {
            yield* deliverDue;
            yield* TestClock.adjust("5 minutes");
          }
          assert.strictEqual(yield* outboxState("doomed-message"), "failed");
          assert.strictEqual(yield* recordsOf("doomed-message"), 0);
          const after = yield* row();
          assert.isFalse(after.unread);
          assert.strictEqual(after.lastActivityAt, before.lastActivityAt);
          assert.deepStrictEqual(yield* markOf, mark);
        }),
      ),
  );

  it.effect(
    "regression #2550: a crash between the bot-thread record and the settle is recovered with one record, one settle and one mark",
    () =>
      withHolds(
        Effect.gen(function* () {
          yield* ready;
          const ledger = yield* Ledger.ChannelLedger;
          yield* (yield* LedgerCallHolds).failNext(
            "recordDelivery",
            new Ledger.ChannelLedgerError({ reason: "ownership_lost", detail: "process stopped" }),
            (input) => input.deliveryId === "crashed",
          );
          yield* TestClock.adjust("1 second");
          yield* queue(message("crashed"));
          assert.isTrue(Exit.isFailure(yield* Effect.exit(deliverDue)));
          assert.strictEqual(yield* recordsOf("crashed"), 1);
          assert.strictEqual(yield* outboxState("crashed"), "delivering");
          assert.isFalse((yield* row()).unread);
          yield* ledger.settleInterruptedDeliveries({ owner: yield* ownerToken, now: yield* now });
          yield* deliverDue;
          assert.strictEqual(yield* recordsOf("crashed"), 1);
          assert.strictEqual(yield* outboxState("crashed"), "delivered");
          const current = yield* row();
          assert.isTrue(current.unread);
          assert.deepStrictEqual(yield* markOf, [
            { value_json: JSON.stringify({ at: current.lastActivityAt }) },
          ]);
        }),
      ),
  );

  it.effect(
    "regression #2550: a post whose mark write fails stays unsettled and read, then settles once without a second record",
    () =>
      provide(
        Effect.gen(function* () {
          yield* ready;
          const before = yield* row();
          yield* refuseMarks;
          yield* TestClock.adjust("1 second");
          yield* deliver(message("refused"));
          assert.strictEqual(yield* recordsOf("refused"), 1);
          assert.strictEqual(yield* outboxState("refused"), "delivering");
          const unsettled = yield* row();
          assert.isFalse(unsettled.unread);
          assert.strictEqual(unsettled.lastActivityAt, before.lastActivityAt);
          yield* allowMarks;
          yield* TestClock.adjust("5 seconds");
          yield* deliverDue;
          assert.strictEqual(yield* recordsOf("refused"), 1);
          assert.strictEqual(yield* outboxState("refused"), "delivered");
          assert.isTrue((yield* row()).unread);
        }),
      ),
  );

  it.effect(
    "regression #2550: a receipt whose mark write fails is settled again inside its deadline and turns the row unread",
    () =>
      provide(
        Effect.gen(function* () {
          yield* ready;
          const input = yield* (yield* ChannelGateway.ChannelGateway).ingest(
            goatInput("one more thing", "receipt-input"),
            rpcContext,
          );
          const receipt: ChannelOutboundMessage = {
            ...message("receipt"),
            kind: "receipt",
            inReplyToInputId: input.inputId,
          };
          yield* refuseMarks;
          yield* (yield* Ledger.ChannelLedger).enqueueDeliveries(
            [
              {
                deliveryId: receipt.deliveryId,
                causeKey: "reply:" + input.inputId,
                inputId: input.inputId,
                taskId,
                message: receipt,
              },
            ],
            yield* now,
          );
          yield* deliverDue;
          assert.strictEqual(yield* recordsOf("receipt"), 1);
          assert.strictEqual(yield* outboxState("receipt"), "delivering");
          assert.isFalse((yield* row()).unread);
          yield* allowMarks;
          yield* TestClock.adjust("5 seconds");
          yield* deliverDue;
          assert.strictEqual(yield* recordsOf("receipt"), 1);
          assert.strictEqual(yield* outboxState("receipt"), "delivered");
          assert.isTrue((yield* row()).unread);
        }),
      ),
  );

  it.effect(
    "regression #2550: a settle that keeps failing past the quick retries settles once the database recovers, freeing the task's later posts",
    () =>
      provide(
        Effect.gen(function* () {
          yield* ready;
          yield* refuseMarks;
          yield* TestClock.adjust("1 second");
          yield* deliver(message("stuck"));
          yield* queue(message("behind"));
          for (let pass = 0; pass < 10; pass++) {
            yield* TestClock.adjust("30 seconds");
            yield* deliverDue;
          }
          assert.strictEqual(yield* outboxState("stuck"), "delivering");
          assert.strictEqual(yield* outboxState("behind"), "pending");
          assert.isFalse((yield* row()).unread);
          yield* allowMarks;
          yield* TestClock.adjust("30 seconds");
          yield* deliverDue;
          assert.strictEqual(yield* recordsOf("stuck"), 1);
          assert.strictEqual(yield* outboxState("stuck"), "delivered");
          assert.strictEqual(yield* outboxState("behind"), "delivered");
          assert.isTrue((yield* row()).unread);
        }),
      ),
  );

  it.effect(
    "regression #2550: past the cap of waiting settles, a recorded post is taken back and settles once the database recovers",
    () =>
      provide(
        Effect.gen(function* () {
          yield* setup;
          const ids = Array.from({ length: 101 }, (_, index) =>
            ChannelTaskId.make("task:sat-" + String(index).padStart(3, "0")),
          );
          for (const id of ids) yield* task(id);
          yield* refuseMarks;
          yield* queue(...ids.map((id) => message("sat-" + id.slice("task:sat-".length), id)));
          yield* deliverDue;
          yield* deliverDue;
          const sql = yield* SqlClient.SqlClient;
          const states = sql<{ readonly state: string; readonly n: number }>`SELECT state,
            count(*) AS n FROM channel_outbox WHERE delivery_id LIKE 'sat-%' GROUP BY state`;
          assert.deepStrictEqual(yield* states, [{ state: "delivering", n: 101 }]);
          yield* allowMarks;
          yield* TestClock.adjust("30 seconds");
          for (let pass = 0; pass < 3; pass++) yield* deliverDue;
          assert.deepStrictEqual(yield* states, [{ state: "delivered", n: 101 }]);
          const [records] = yield* sql<{ readonly n: number }>`SELECT count(*) AS n
            FROM orchestration_command_receipts WHERE command_type = 'channel.timeline.record'`;
          assert.strictEqual(records?.n, 101);
          const [marks] = yield* sql<{ readonly n: number }>`SELECT count(*) AS n
            FROM channel_runtime_state WHERE key LIKE 'task-message-mark:%'`;
          assert.strictEqual(marks?.n, 101);
        }),
      ),
  );

  it.effect(
    "regression #2550: an overflow that lands while a recovery scan runs is kept for the next scan",
    () =>
      withHolds(
        Effect.gen(function* () {
          yield* setup;
          const ids = Array.from({ length: 101 }, (_, index) =>
            ChannelTaskId.make("task:scan-" + String(index).padStart(3, "0")),
          );
          for (const id of ids) yield* task(id);
          yield* refuseMarks;
          yield* queue(...ids.map((id) => message("scan-" + id.slice("task:scan-".length), id)));
          yield* deliverDue;
          yield* deliverDue;
          // 100 settles wait and one post is over the cap, so a scan is due 30 seconds from now.
          yield* TestClock.adjust("30 seconds");
          const input = yield* (yield* ChannelGateway.ChannelGateway).ingest(
            goatInput("and this", "scan-receipt-input"),
            rpcContext,
          );
          const receipt: ChannelOutboundMessage = {
            ...message("scan-receipt", ids[0]),
            kind: "receipt",
            inReplyToInputId: input.inputId,
          };
          yield* (yield* Ledger.ChannelLedger).enqueueDeliveries(
            [
              {
                deliveryId: receipt.deliveryId,
                causeKey: "reply:" + input.inputId,
                inputId: input.inputId,
                taskId: ids[0],
                message: receipt,
              },
            ],
            yield* now,
          );
          const token = yield* ownerToken;
          const worker = yield* ChannelDeliveryWorker.ChannelDeliveryWorker;
          const holds = yield* LedgerCallHolds;
          // The receipt is sent and in flight, its settle held, when the scan takes its snapshot.
          const settle = yield* holds.holdNext(
            "recordDelivery",
            (call) => call.deliveryId === "scan-receipt",
          );
          yield* worker.deliverReceipts(token);
          yield* settle.reached;
          const scan = yield* holds.holdNext("releaseUnsentDeliveries");
          const pass = yield* Effect.forkChild(worker.deliverDue(token));
          yield* scan.reached;
          // While the scan is held, the receipt's settle fails and finds the queue full.
          yield* settle.release;
          yield* worker.settleReceipts;
          assert.strictEqual(yield* outboxState("scan-receipt"), "delivering");
          yield* allowMarks;
          yield* scan.release;
          yield* Fiber.join(pass);
          assert.strictEqual(yield* outboxState("scan-receipt"), "delivering");
          yield* TestClock.adjust("30 seconds");
          for (let round = 0; round < 3; round++) yield* deliverDue;
          assert.strictEqual(yield* outboxState("scan-receipt"), "delivered");
          assert.strictEqual(yield* recordsOf("scan-receipt"), 1);
        }),
      ),
  );

  it.effect(
    "contract #2550: a narrated message is recorded and settled in the pass that narrates it, so the row is unread and announced without another pass",
    () =>
      provide(
        Effect.gen(function* () {
          yield* ready;
          const runtime = yield* ChannelRuntime.ChannelRuntime;
          const token = yield* ownerToken;
          const ledger = yield* Ledger.ChannelLedger;
          yield* TestClock.adjust("1 second");
          const changed = yield* commitTransition(
            ledger,
            (yield* ledger.getTask(taskId))!,
            {
              type: "task.progress",
              payload: { generation: 1, summary: "Halfway there", milestone: true },
            },
            { owner: token, narrate: true },
          );
          assert.isDefined(changed);
          const seen = yield* watchTaskChanges(owner);
          assert.isFalse((yield* row()).unread);
          yield* runtime.runPass;
          const sql = yield* SqlClient.SqlClient;
          const told = yield* sql<{ readonly state: string; readonly delivery_id: string }>`SELECT
            state, delivery_id FROM channel_outbox WHERE cause_key LIKE 'narration:%:origin'`;
          assert.deepStrictEqual(
            told.map((item) => item.state),
            ["delivered"],
          );
          assert.strictEqual(yield* recordsOf(told[0]!.delivery_id), 1);
          assert.isTrue((yield* row()).unread);
          yield* TestClock.adjust(TASK_CHANGES_COALESCE);
          assert.isTrue(Option.isSome(yield* Queue.poll(seen)));
        }),
      ),
  );

  it.effect(
    "regression #3237: a failing take-back scan is logged once while it keeps failing and still retries until it succeeds",
    () => {
      const log = warnings();
      return Effect.gen(function* () {
        yield* setup;
        const ids = Array.from({ length: 101 }, (_, index) =>
          ChannelTaskId.make("task:fail-" + String(index).padStart(3, "0")),
        );
        for (const id of ids) yield* task(id);
        yield* refuseMarks;
        yield* queue(...ids.map((id) => message("fail-" + id.slice("task:fail-".length), id)));
        yield* deliverDue;
        yield* deliverDue;
        yield* allowMarks;
        const holds = yield* LedgerCallHolds;
        const refused = new Ledger.ChannelLedgerError({ reason: "persistence", detail: "busy" });
        yield* holds.failNext("releaseUnsentDeliveries", refused);
        yield* holds.failNext("releaseUnsentDeliveries", refused);
        for (let pass = 0; pass < 2; pass++) {
          yield* TestClock.adjust("30 seconds");
          yield* deliverDue;
        }
        const failures = () => log.logs.filter((entry) => entry.includes("take-back scan failed"));
        assert.lengthOf(failures(), 1);
        yield* TestClock.adjust("30 seconds");
        for (let pass = 0; pass < 3; pass++) yield* deliverDue;
        const sql = yield* SqlClient.SqlClient;
        const states = yield* sql<{ readonly state: string; readonly n: number }>`SELECT state,
          count(*) AS n FROM channel_outbox WHERE delivery_id LIKE 'fail-%' GROUP BY state`;
        assert.deepStrictEqual(states, [{ state: "delivered", n: 101 }]);
        assert.lengthOf(failures(), 1);
      }).pipe(
        Effect.provide(
          Layer.merge(
            BotThreads.layer.pipe(
              Layer.provideMerge(Views.layer),
              Layer.provideMerge(Layer.provideMerge(LedgerCallHolds.layer, makeHarness().layer)),
            ),
            log.layer,
          ),
        ),
      );
    },
  );
});
